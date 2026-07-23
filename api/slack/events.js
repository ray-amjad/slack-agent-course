import crypto from "node:crypto";

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const MIN = Number(process.env.RANDOM_MIN ?? 1);
const MAX = Number(process.env.RANDOM_MAX ?? 100);

/**
 * Reads the untouched request body. Signature verification hashes the exact
 * bytes Slack sent, so re-serialising a parsed object would not survive.
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Verifies the request actually came from Slack.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
function isValidSlackRequest(rawBody, timestamp, signature) {
  if (!timestamp || !signature) return false;

  // Reject anything older than 5 minutes (replay protection).
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const expected =
    "v0=" +
    crypto
      .createHmac("sha256", SIGNING_SECRET)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function postThreadReply(channel, threadTs, text) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });

  const data = await res.json();
  if (!data.ok) console.error("chat.postMessage failed:", data.error);
}

function send(res, status, body) {
  res.statusCode = status;
  if (body === undefined) return res.end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405);

  if (!SIGNING_SECRET || !BOT_TOKEN) {
    console.error("Missing SLACK_SIGNING_SECRET or SLACK_BOT_TOKEN");
    return send(res, 500);
  }

  const rawBody = await readRawBody(req);

  if (
    !isValidSlackRequest(
      rawBody,
      req.headers["x-slack-request-timestamp"],
      req.headers["x-slack-signature"],
    )
  ) {
    return send(res, 401);
  }

  const payload = JSON.parse(rawBody);

  // One-time URL verification when you point Slack at this endpoint.
  if (payload.type === "url_verification") {
    return send(res, 200, { challenge: payload.challenge });
  }

  // Slack retries if we're slow; don't post a duplicate number.
  if (req.headers["x-slack-retry-num"]) return send(res, 200);

  const event = payload.event;
  if (event?.type === "app_mention" && !event.bot_id) {
    const number = crypto.randomInt(MIN, MAX + 1);
    // Reply inside the existing thread if there is one, otherwise start one.
    await postThreadReply(
      event.channel,
      event.thread_ts ?? event.ts,
      `🎲 ${number}`,
    );
  }

  return send(res, 200);
}
