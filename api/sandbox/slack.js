import {
  fetchChannelInfo,
  fetchHistory,
  fetchThreadReplies,
  listConversations,
  readError,
  searchContext,
} from "../../lib/slack.js";
import { verifyCapability } from "../../lib/slack-proxy.js";

/**
 * The Slack read proxy: the only door between a sandbox and the workspace.
 *
 * A sandbox POSTs here with the capability `lib/slack-proxy.js` minted for its
 * run; this function verifies the signature and makes the actual Slack call
 * with `SLACK_BOT_TOKEN`, which never leaves Vercel. Read-only by construction:
 * there is no action here that writes, so a compromised or confused sandbox
 * cannot post, edit, react, or upload as Joestar no matter what it sends.
 *
 * IT IS A PUBLIC URL. Anyone can POST to it; the HMAC is the whole gate, and
 * capabilities expire with the run that minted them. That is the same posture
 * as the Slack events endpoint next door, which is also public and also
 * defended by a signature alone.
 *
 * THE TIER RULE. A run answering in a PUBLIC channel may only read public
 * channels. Without it, "@Joestar summarise #leadership" in a public channel
 * becomes a way to launder private conversations into one — the agent would be
 * doing exactly as asked, and the leak would look like a feature. The origin
 * channel's privacy is a signed claim, so the sandbox cannot widen its own
 * access by asking nicely. It mirrors the public/private split the memory tiers
 * already use in lib/agent-memory.js: read down, never up.
 *
 * A run in a PRIVATE channel is not automatically trusted with everything
 * either — it can still only reach channels the bot was invited to, because
 * that is all a bot token can read.
 */

// Bounds on what one call can pull back, so a single request cannot blow up the
// agent's context (or this function's response). Slack's own cap on
// assistant.search.context is 20, which is where SEARCH_MAX comes from.
const MAX_MESSAGES = 50;
const MAX_CHANNELS = 200;
const SEARCH_MAX = 20;

// Long messages are usually pasted logs. Keep the shape, drop the bulk — the
// agent can always ask for the thread if a truncated message looks important.
const MAX_TEXT_CHARS = 1500;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

function clip(text = "") {
  const s = String(text);
  return s.length > MAX_TEXT_CHARS ? `${s.slice(0, MAX_TEXT_CHARS)}… [truncated]` : s;
}

/**
 * Slack message objects are enormous — blocks, attachments, reactions, edit
 * history, client metadata — and almost all of it is noise to a reader. Project
 * to the handful of fields that carry meaning, because everything kept here is
 * paid for twice: once in this response, once in the agent's context.
 */
function projectMessage(m) {
  return {
    ts: m.ts,
    user: m.user || m.bot_id || null,
    text: clip(m.text || ""),
    ...(m.thread_ts && m.thread_ts !== m.ts ? { threadTs: m.thread_ts } : {}),
    ...(m.reply_count ? { replyCount: m.reply_count } : {}),
    ...(Array.isArray(m.files) && m.files.length ? { files: m.files.length } : {}),
  };
}

const clamp = (value, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
};

/**
 * Enforces the tier rule for a specific target channel.
 *
 * Costs one `conversations.info` call, which is the price of not trusting the
 * sandbox's word for what it is reading. Fails CLOSED: a lookup that errors
 * blocks the read rather than allowing it, for the same reason
 * `fetchChannelInfo` defaults `isPrivate` to true.
 */
async function assertReadable(channel, capability) {
  if (capability.isPrivate) return; // a private run may read anything the bot can

  const info = await fetchChannelInfo(channel);
  if (info.isPrivate) {
    const err = new Error(
      "This run is answering in a public channel, so it may only read public channels. " +
        "That target is private (or could not be confirmed public). Ask the user to run this from the private channel itself.",
    );
    err.status = 403;
    throw err;
  }
}

const ACTIONS = {
  /** Channels the workspace has, annotated with whether the bot can actually read each. */
  async channels(body, capability) {
    const types = capability.isPrivate ? "public_channel,private_channel" : "public_channel";
    const channels = await listConversations({
      types,
      limit: clamp(body.limit, MAX_CHANNELS, MAX_CHANNELS),
    });

    const match = (body.query || "").trim().toLowerCase();
    const filtered = match
      ? channels.filter(
          (c) =>
            c.name?.toLowerCase().includes(match) ||
            c.topic?.toLowerCase().includes(match) ||
            c.purpose?.toLowerCase().includes(match),
        )
      : channels;

    return {
      channels: filtered,
      note: "`isMember: false` means Joestar cannot read that channel's messages — it has to be invited first.",
    };
  },

  /** Recent messages in one channel. */
  async history(body, capability) {
    if (!body.channel) throw badRequest("history needs a channel id");
    await assertReadable(body.channel, capability);

    const messages = await fetchHistory({
      channel: body.channel,
      limit: clamp(body.limit, MAX_MESSAGES, 20),
      oldest: body.oldest,
      latest: body.latest,
    });
    return { channel: body.channel, messages: messages.map(projectMessage) };
  },

  /** One thread, in any readable channel. */
  async thread(body, capability) {
    if (!body.channel || !body.ts) throw badRequest("thread needs a channel id and a ts");
    await assertReadable(body.channel, capability);

    const messages = await fetchThreadReplies({
      channel: body.channel,
      threadTs: body.ts,
      limit: clamp(body.limit, MAX_MESSAGES, MAX_MESSAGES),
    });
    return { channel: body.channel, ts: body.ts, messages: messages.map(projectMessage) };
  },

  /**
   * Workspace search. Public channels only — that is a property of the bot
   * token, not a rule we impose, so it holds even for a run in a private
   * channel. No tier check needed for the same reason.
   */
  async search(body, capability) {
    if (!body.query) throw badRequest("search needs a query");
    if (!capability.actionToken) {
      const err = new Error(
        "Search is unavailable this turn: Slack only issues the required action_token on a message that @mentions Joestar. " +
          "A threaded follow-up that does not tag the bot does not carry one. Ask the user to tag @Joestar in their message and search will work.",
      );
      err.status = 409;
      throw err;
    }

    const results = await searchContext({
      query: body.query,
      actionToken: capability.actionToken,
      limit: clamp(body.limit, SEARCH_MAX, SEARCH_MAX),
      // Lets Slack bias results toward the channel the question was asked in.
      contextChannel: capability.channelId,
    });

    return {
      query: body.query,
      results: results.map((m) => ({
        text: clip(m.text || ""),
        user: m.author_user_id || m.user || null,
        channel: m.channel?.name ? `#${m.channel.name}` : m.channel?.id || null,
        channelId: m.channel?.id || null,
        ts: m.ts,
        permalink: m.permalink || null,
      })),
      note: "Search covers PUBLIC channels only — a bot token cannot search private channels or DMs.",
    };
  },
};

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "POST only" });

  if (!process.env.SLACK_BOT_TOKEN) {
    console.error("sandbox/slack: SLACK_BOT_TOKEN is not set");
    return send(res, 500, { ok: false, error: "proxy is not configured" });
  }

  let capability;
  try {
    const header = req.headers.authorization || "";
    capability = verifyCapability(header.replace(/^Bearer\s+/i, ""));
  } catch (err) {
    // Logged, but never echoed back — a probe should not learn which part of
    // its token we disliked.
    console.warn("sandbox/slack: rejected capability:", err.message);
    return send(res, 401, { ok: false, error: "invalid or expired capability" });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return send(res, 400, { ok: false, error: err.message });
  }

  const action = ACTIONS[body.action];
  if (!action) {
    return send(res, 400, {
      ok: false,
      error: `unknown action ${JSON.stringify(body.action ?? null)} — expected one of ${Object.keys(ACTIONS).join(", ")}`,
    });
  }

  try {
    const data = await action(body, capability);
    return send(res, 200, { ok: true, ...data });
  } catch (err) {
    if (err.status) return send(res, err.status, { ok: false, error: err.message });
    // A Slack-side failure. readError turns the ones with an obvious next step
    // (invite the bot, reinstall the app, back off) into that next step.
    const message = readError(err);
    console.error(`sandbox/slack: ${body.action} failed:`, message);
    return send(res, 502, { ok: false, error: message });
  }
}
