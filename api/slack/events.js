import crypto from "node:crypto";

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const MIN = Number(process.env.RANDOM_MIN ?? 1);
const MAX = Number(process.env.RANDOM_MAX ?? 100);

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

export default async function handler(request) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const rawBody = await request.text();

  if (
    !isValidSlackRequest(
      rawBody,
      request.headers.get("x-slack-request-timestamp"),
      request.headers.get("x-slack-signature"),
    )
  ) {
    return new Response("Invalid signature", { status: 401 });
  }

  const payload = JSON.parse(rawBody);

  // One-time URL verification when you point Slack at this endpoint.
  if (payload.type === "url_verification") {
    return Response.json({ challenge: payload.challenge });
  }

  // Slack retries if we're slow; don't post a duplicate number.
  if (request.headers.get("x-slack-retry-num")) {
    return new Response("", { status: 200 });
  }

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

  return new Response("", { status: 200 });
}
