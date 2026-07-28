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
 * Fetches the two things one `conversations.info` call can tell us.
 *
 * The topic, because channels are commonly set up with the relevant GitHub repo
 * named in it, so surfacing it in the prompt lets the agent skip guessing (or
 * searching) for which repo a request is about.
 *
 * And whether the channel is private, because that picks which long-term memory
 * tier this run gets: a public channel may write into the shared workspace
 * directory, a private one reads it but never writes back. DMs and group DMs
 * count as private — they are the case where getting this backwards would be
 * most obviously wrong.
 *
 * `isPrivate` falls back to `true` whenever we could not determine it, including
 * when the call fails outright. The asymmetry is deliberate: a wrong "public"
 * publishes a private channel's notes to every other channel, while a wrong
 * "private" only means a silo that is more isolated than it needed to be.
 *
 * `privacyKnown` exists because that fallback is only safe for callers whose
 * cautious direction is "more private". The Slack read capability's is the
 * OPPOSITE — there, `isPrivate: true` GRANTS the run the right to read private
 * channels, so silently defaulting to it on a rate-limited `conversations.info`
 * would upgrade a public run's reach rather than restrict it. Callers who care
 * about that direction must gate on `privacyKnown`, not just `isPrivate`.
 *
 * @returns {Promise<{topic: string|null, isPrivate: boolean, privacyKnown: boolean}>}
 */
export async function fetchChannelInfo(channel) {
  try {
    const res = await web.conversations.info({ channel });
    const info = res.channel ?? {};
    return {
      topic: info.topic?.value || null,
      isPrivate: Boolean(info.is_private ?? true) || Boolean(info.is_im) || Boolean(info.is_mpim),
      // Slack always sets `is_private` on a real channel object, so its absence
      // means we got something we don't understand — not a public channel.
      privacyKnown: info.is_private !== undefined,
    };
  } catch (err) {
    console.error("conversations.info failed:", err.data?.error || err.message);
    return { topic: null, isPrivate: true, privacyKnown: false };
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
 * The reads that reach BEYOND the current thread, used only by
 * `api/sandbox/slack.js` on behalf of a sandbox holding a capability token.
 *
 * Everything above this point answers the message we were tagged in. Everything
 * below it answers "what else is going on in this workspace", which is a
 * different privilege — hence the separate entry point, and hence these being
 * plain functions the endpoint calls rather than anything the sandbox can reach.
 *
 * The membership rule is the thing to know before reading further: with a BOT
 * token, `conversations.history` only works in channels the bot has been
 * invited to. Slack's docs are unambiguous ("Any conversation the relevant bot
 * is a member of"), and the failure is a `not_in_channel` error rather than an
 * empty result — which is why `readError` below translates it into something an
 * agent can act on instead of retrying.
 */

/**
 * Lists channels, newest-activity-agnostic, capped. `types` decides the tier.
 *
 * Paginated, which matters more than it looks: this is the only way an agent
 * can turn `#deploys` into `C0123`, so a truncated list doesn't read as "the
 * list was truncated" — it reads as "that channel doesn't exist", and the agent
 * confidently tells the user so. Slack returns pages of at most 1000 and
 * `conversations.list` is a Tier 2 method, so the page budget is a real bound
 * on how long one `slack-read channels` can take.
 *
 * Reports `truncated` rather than pretending the cap wasn't hit, so callers can
 * say which of the two situations they're in.
 *
 * @returns {Promise<{channels: object[], truncated: boolean}>}
 */
export async function listConversations({ types, limit = 1000, maxPages = 5 }) {
  const channels = [];
  let cursor;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const res = await web.conversations.list({
      types,
      exclude_archived: true,
      limit: Math.min(200, limit - channels.length),
      ...(cursor ? { cursor } : {}),
    });

    for (const c of res.channels || []) {
      channels.push({
        id: c.id,
        name: c.name,
        isPrivate: Boolean(c.is_private),
        isMember: Boolean(c.is_member),
        topic: c.topic?.value || null,
        purpose: c.purpose?.value || null,
      });
    }

    cursor = res.response_metadata?.next_cursor || null;
    if (!cursor) break;
    if (channels.length >= limit) {
      truncated = true;
      break;
    }
    if (page === maxPages - 1) truncated = true;
  }

  return { channels, truncated };
}

/**
 * Whether a specific USER is in a channel — the check that keeps "Joestar can
 * read it" from meaning "anyone who can DM Joestar can read it".
 *
 * The bot's own membership is what Slack enforces; it is not what the person
 * asking is entitled to. Without this, a workspace member who DMs the bot gets
 * a private-tier run and can read every private channel the bot was ever
 * invited to, including ones they were deliberately left out of.
 *
 * Fails CLOSED — an error, a missing scope, or a channel too large to page
 * through all return false, because "we could not confirm you are in there" and
 * "you are not in there" should have the same consequence.
 */
export async function isChannelMember(channel, userId, { maxPages = 10 } = {}) {
  if (!channel || !userId) return false;

  let cursor;
  try {
    for (let page = 0; page < maxPages; page++) {
      const res = await web.conversations.members({
        channel,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      if ((res.members || []).includes(userId)) return true;

      cursor = res.response_metadata?.next_cursor || null;
      if (!cursor) return false;
    }
    console.warn(`conversations.members: ${channel} exceeded ${maxPages} pages — denying`);
    return false;
  } catch (err) {
    console.error("conversations.members failed:", err.data?.error || err.message);
    return false;
  }
}

export async function fetchHistory({ channel, limit = 50, oldest, latest }) {
  const res = await web.conversations.history({
    channel,
    limit,
    ...(oldest ? { oldest } : {}),
    ...(latest ? { latest } : {}),
  });
  return res.messages || [];
}

/**
 * Workspace search, via the Real-time Search API rather than `search.messages`.
 *
 * `search.messages` is user-token-only (and now legacy), so it would have meant
 * asking someone to authorize an `xoxp-` token that can read everything they
 * can. `assistant.search.context` takes a BOT token instead — provided you pass
 * the `action_token` Slack puts on the triggering event.
 *
 * The consequence worth knowing: a bot token carries `search:read.public` and
 * nothing else (`search:read.private` is user-token-only), so this searches
 * public channels only, no matter what `channel_types` we ask for. That is a
 * feature here — it means search cannot leak a private channel into a run, and
 * we do not have to enforce that ourselves.
 *
 * Slack caps `limit` at 20.
 */
export async function searchContext({ query, actionToken, limit = 20, contextChannel }) {
  const res = await web.apiCall("assistant.search.context", {
    query,
    ...(actionToken ? { action_token: actionToken } : {}),
    channel_types: "public_channel",
    content_types: "messages",
    limit: Math.min(limit, 20),
    ...(contextChannel ? { context_channel_id: contextChannel } : {}),
  });
  return res.results?.messages || [];
}

/**
 * Turns a Slack API error into a sentence the agent can act on.
 *
 * Worth the translation because the three common failures all mean "do
 * something different", and Slack's raw error strings say so only if you
 * already know the API: `not_in_channel` means invite the bot, `missing_scope`
 * means the app needs reinstalling, `ratelimited` means wait rather than retry.
 * An agent handed the bare code will typically retry all three forever.
 */
export function readError(err) {
  const code = err.data?.error || err.message;
  switch (code) {
    case "not_in_channel":
    case "channel_not_found":
      return `${code}: Joestar is not a member of that channel (or it does not exist). Ask the user to /invite @Joestar there — this cannot be worked around.`;
    case "missing_scope":
      return `missing_scope: the Slack app lacks the scope for this call (needs ${err.data?.needed || "an additional scope"}). The app has to be reinstalled with it; you cannot fix this from here.`;
    case "ratelimited":
      return "ratelimited: Slack is throttling reads. Wait before trying again, and read fewer channels.";
    default:
      return String(code);
  }
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
