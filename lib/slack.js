import { WebClient } from "@slack/web-api";

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// One shared client. It handles rate limits and retries for us, and is the
// only thing in this repo that talks to the Slack Web API.
export const web = new WebClient(BOT_TOKEN);

// The placeholder we post while Claude works. Also the string renderTranscript
// filters out, so an in-flight "thinking" bubble never leaks into context.
export const THINKING_TEXT = "🧠 Thinking…";

// Icon per Claude Code tool name, for the progress line. Anything not listed
// falls back to a generic gear so an unrecognised (or future) tool still
// renders instead of being silently dropped.
const TOOL_ICONS = {
  Bash: "🖥️",
  Read: "📖",
  Write: "📝",
  Edit: "📝",
  MultiEdit: "📝",
  Grep: "🔍",
  Glob: "🔍",
  WebFetch: "🌐",
  WebSearch: "🌐",
  Task: "🧩",
  TodoWrite: "🗒️",
};

function truncateInline(text, max = 80) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** One-line summary of the tool call currently in flight. */
function describeTool(name, input = {}) {
  const icon = TOOL_ICONS[name] || "⚙️";
  switch (name) {
    case "Bash":
      return `${icon} Running \`${truncateInline(input.command)}\``;
    case "Read":
      return `${icon} Reading \`${input.file_path}\``;
    case "Write":
      return `${icon} Writing \`${input.file_path}\``;
    case "Edit":
    case "MultiEdit":
      return `${icon} Editing \`${input.file_path}\``;
    case "Grep":
      return `${icon} Searching for \`${truncateInline(input.pattern)}\``;
    case "Glob":
      return `${icon} Finding \`${truncateInline(input.pattern)}\``;
    case "WebFetch":
      return `${icon} Fetching ${truncateInline(input.url)}`;
    case "WebSearch":
      return `${icon} Searching web for \`${truncateInline(input.query)}\``;
    case "Task":
      return `${icon} Running subagent`;
    case "TodoWrite":
      return `${icon} Updating todo list`;
    default:
      return `${icon} Using \`${name}\``;
  }
}

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Builds the ticking status line: the thinking placeholder, or — once the
 * first tool call has come back — a one-line description of the latest one,
 * either way suffixed with how long the run has been going.
 */
export function progressText({ elapsedMs, tool }) {
  const base = tool ? describeTool(tool.name, tool.input) : THINKING_TEXT;
  return `${base} (${formatElapsed(elapsedMs)})`;
}

const ELAPSED_SUFFIX_RE = /\s\(\d+(?:m \d+)?s\)$/;

/**
 * True for THINKING_TEXT and every ticking variant progressText() can
 * produce, so an in-flight placeholder never leaks into transcript replay —
 * the same job THINKING_TEXT's exact-match check used to do on its own,
 * before the placeholder started changing every 5s.
 */
function isProgressText(text) {
  if (text === THINKING_TEXT) return true;
  if (!ELAPSED_SUFFIX_RE.test(text)) return false;
  return [THINKING_TEXT[0], ...Object.values(TOOL_ICONS), "⚙️"].some((icon) =>
    text.startsWith(icon),
  );
}

/**
 * The bot's own user id, from `auth.test`, cached for the lifetime of the warm
 * function instance. We need it to recognise (and ignore) our own posts once we
 * subscribe to `message.*`, and to decide whether a thread is ours.
 */
let cachedBotUserId;
export async function getBotUserId() {
  if (cachedBotUserId) return cachedBotUserId;
  const res = await web.auth.test();
  cachedBotUserId = res.user_id;
  return cachedBotUserId;
}

/**
 * Turns raw Slack text into what the user actually typed: drops `<@BOT>`
 * mentions, unwraps Slack's `<url|label>` link markup, and undoes the three
 * entities Slack escapes.
 */
export function extractPrompt(text = "") {
  return text
    .replace(/<@[A-Z0-9]+>/gi, " ")
    .replace(/<(https?:[^|>]+)\|[^>]*>/gi, "$1")
    .replace(/<(https?:[^>]+)>/gi, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export async function postMessage({ channel, threadTs, text }) {
  return web.chat.postMessage({ channel, thread_ts: threadTs, text });
}

/**
 * Posts the "thinking" placeholder and returns its `ts` so the caller can edit
 * it in place with the final answer. Returns null if the post failed — the
 * caller falls back to a fresh message.
 */
export async function postThinking({ channel, threadTs }) {
  try {
    const res = await web.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: THINKING_TEXT,
    });
    return res.ts;
  } catch (err) {
    console.error("postThinking failed:", err.data?.error || err.message);
    return null;
  }
}

/**
 * Edits the placeholder in place if we have its `ts`; otherwise posts a fresh
 * message into the thread.
 */
export async function finalize({ channel, threadTs, ts, text }) {
  if (ts) return web.chat.update({ channel, ts, text });
  return web.chat.postMessage({ channel, thread_ts: threadTs, text });
}

/**
 * Edits the placeholder with a live progress update (elapsed time, latest
 * tool call). Swallows failures — a missed tick must never sink the run; the
 * next tick, or the terminal `finalize`, will catch up.
 */
export async function updateProgress({ channel, ts, text }) {
  if (!ts) return;
  try {
    await web.chat.update({ channel, ts, text });
  } catch (err) {
    console.error("updateProgress failed:", err.data?.error || err.message);
  }
}

/**
 * Adds a reaction, swallowing `already_reacted` (which just means we (or a
 * retry) got there first). Every other failure is logged, never thrown — a
 * missing emoji must not sink the actual run.
 */
export async function addReaction({ channel, timestamp, name }) {
  try {
    await web.reactions.add({ channel, timestamp, name });
  } catch (err) {
    const code = err.data?.error;
    if (code === "already_reacted") return;
    console.error(`reactions.add ${name} failed:`, code || err.message);
  }
}

/**
 * Fetches the channel's topic, if any. Channels are commonly set up with the
 * relevant GitHub repo named in the topic, so surfacing it in the prompt lets
 * the agent skip guessing (or searching) for which repo a request is about.
 */
export async function fetchChannelTopic(channel) {
  try {
    const res = await web.conversations.info({ channel });
    return res.channel?.topic?.value || null;
  } catch (err) {
    console.error("conversations.info failed:", err.data?.error || err.message);
    return null;
  }
}

export async function fetchThreadReplies({ channel, threadTs, limit = 20 }) {
  try {
    const res = await web.conversations.replies({
      channel,
      ts: threadTs,
      limit,
    });
    return res.messages || [];
  } catch (err) {
    console.error("conversations.replies failed:", err.data?.error || err.message);
    return [];
  }
}

/**
 * True if the bot has already posted in this set of thread messages. A message
 * we posted via `chat.postMessage` comes back with `user` set to our own user
 * id, so that's the reliable tell that the thread is ours to continue.
 */
export function botOwnsThread(messages, botUserId) {
  return messages.some((m) => m.user === botUserId);
}

/**
 * Renders prior thread messages as `speaker: text` lines for transcript replay.
 * Skips the triggering message (that's the new prompt), Slack's structural
 * subtypes (joins, edits…), and our own "thinking" placeholder.
 */
export function renderTranscript(messages, { botUserId, excludeTs }) {
  const lines = [];
  for (const m of messages) {
    if (m.ts === excludeTs) continue;
    if (m.subtype && m.subtype !== "file_share") continue;

    const isBot = m.user === botUserId || Boolean(m.bot_id);
    const text = extractPrompt(m.text || "");
    const fileCount = Array.isArray(m.files) ? m.files.length : 0;

    if (isBot && (isProgressText(text) || text === "")) continue;
    if (!text && !fileCount) continue;

    const speaker = isBot ? "Joestar" : `User ${m.user || "unknown"}`;
    const suffix = fileCount ? ` [attached ${fileCount} file(s)]` : "";
    lines.push(`${speaker}: ${text}${suffix}`.trim());
  }
  return lines.join("\n");
}

/**
 * Downloads a Slack-hosted file with the bot token.
 *
 * The load-bearing gotcha: a `url_private` fetch with a missing or insufficient
 * token returns HTTP 200 with an HTML sign-in page, NOT a 401. So a naive
 * `res.ok` check hands you a chunk of HTML believing it's the file. We sniff
 * `content-type` and treat any `text/html` body as failure.
 *
 * Returns `{ name, data, mimetype }` or null (logged) on any failure.
 */
export async function downloadSlackFile(file, { maxBytes } = {}) {
  const url = file.url_private_download || file.url_private;
  if (!url) return null;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${BOT_TOKEN}` },
    });
    if (!res.ok) {
      console.error(`download ${file.name} failed: HTTP ${res.status}`);
      return null;
    }
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      console.error(
        `download ${file.name}: got HTML, not bytes — missing files:read or bot not in channel`,
      );
      return null;
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (maxBytes && data.length > maxBytes) {
      console.error(`download ${file.name}: ${data.length} bytes over ${maxBytes} cap`);
      return null;
    }
    return { name: file.name, data, mimetype: file.mimetype };
  } catch (err) {
    console.error(`download ${file.name} threw:`, err.message);
    return null;
  }
}

/**
 * Step 1 of the external-upload flow, and the only step that needs the bot
 * token: mints a single-use upload URL plus a file id for a file we haven't
 * sent yet. The caller hands the URL (not the token) to whatever actually
 * holds the bytes — e.g. the E2B sandbox — so it can POST them straight to
 * Slack's file-upload service without ever routing through this process's
 * memory. Same shape as the single-use GitHub installation token: mint a
 * narrow, one-time credential rather than handing out the long-lived secret.
 */
export async function mintUploadURL({ filename, length }) {
  const res = await web.files.getUploadURLExternal({ filename, length });
  return { uploadUrl: res.upload_url, fileId: res.file_id };
}

/**
 * Step 3 of the external-upload flow: finalizes file(s) already POSTed to
 * their minted upload URL(s) and shares them into the thread. Batching every
 * file from one run into a single call posts them as one message with
 * multiple attachments instead of one message per file.
 *
 * Slack silently discards an upload that never reaches this call, so only
 * pass fileIds whose POST actually succeeded — there's no cleanup needed for
 * the ones that didn't.
 */
export async function completeUpload({ channel, threadTs, files, initialComment }) {
  return web.files.completeUploadExternal({
    channel_id: channel,
    thread_ts: threadTs,
    files, // [{ id, title }]
    initial_comment: initialComment,
  });
}
