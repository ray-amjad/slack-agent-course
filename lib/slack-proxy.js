import crypto from "node:crypto";

/**
 * The capability token that lets a sandbox read Slack without holding a Slack
 * credential.
 *
 * THE PROBLEM. `SLACK_BOT_TOKEN` can post as Joestar, upload files, and read
 * every channel the bot is in. The sandbox runs model-authored code with
 * `--dangerously-skip-permissions`, so anything in its environment is
 * effectively public to whoever can @mention the bot. Handing it the bot token
 * to enable channel reads would trade a read feature for a write capability.
 *
 * THE SHAPE. Same move as `lib/github.js` and `mintUploadURL`: the long-lived
 * secret stays in the Vercel function, and what crosses into the sandbox is a
 * narrow, expiring capability — here a signed statement of "this run may read
 * Slack, on behalf of channel X, until T". `api/sandbox/slack.js` verifies it
 * and makes the actual Slack call with the real token.
 *
 * IT IS SIGNED, NOT ENCRYPTED. The payload is base64url, so the sandbox can
 * read its own claims — that's fine, they describe the run it is already part
 * of. What it cannot do is change them, because it has no key to re-sign with.
 * The one non-obvious passenger is `at` (Slack's `action_token`, needed for
 * search); on its own it authenticates nothing, since every call to Slack still
 * requires the bot token this file exists to withhold.
 */

// Domain separation rather than a new secret to configure. Reusing
// SLACK_SIGNING_SECRET's bytes directly for a second purpose is how you end up
// with a token from one scheme being valid in the other; running it through
// HMAC with a fixed label yields a key that is unrelated to the original and
// unrelated to any other label we might add later. JOESTAR_PROXY_SECRET
// overrides it, which is the rotation story: set it, redeploy, every
// outstanding capability is instantly worthless.
const LABEL = "joestar-sandbox-slack-proxy-v1";

function signingKey() {
  const override = process.env.JOESTAR_PROXY_SECRET;
  if (override) return Buffer.from(override, "utf8");

  const base = process.env.SLACK_SIGNING_SECRET;
  if (!base) return null;
  return crypto.createHmac("sha256", base).update(LABEL).digest();
}

/**
 * Where the sandbox should call back to.
 *
 * `VERCEL_PROJECT_PRODUCTION_URL` is injected by Vercel on every deployment and
 * always names the production domain — not the per-deployment preview URL,
 * which is what makes it the right one here: a capability minted by a preview
 * deploy still has to reach an endpoint that exists. Set JOESTAR_PUBLIC_URL to
 * override (custom domain, or local tunnel while developing).
 */
function baseUrl() {
  const explicit = process.env.JOESTAR_PUBLIC_URL;
  if (explicit) return explicit.replace(/\/$/, "");

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return vercel ? `https://${vercel}` : null;
}

/** True once we can both sign a capability and tell the sandbox where to spend it. */
export function isConfigured() {
  return Boolean(signingKey() && baseUrl());
}

export function proxyUrl() {
  const base = baseUrl();
  return base ? `${base}/api/sandbox/slack` : null;
}

const b64url = (input) => Buffer.from(input).toString("base64url");

/**
 * Mints one capability for one run.
 *
 * @param {object}  claims
 * @param {string}  claims.channelId   the channel this run is answering in
 * @param {boolean} claims.isPrivate   whether that channel is private or a DM.
 *                                     Signed, so the sandbox cannot claim
 *                                     otherwise to widen what it may read —
 *                                     see the tier rule in api/sandbox/slack.js
 * @param {string}  [claims.actionToken] Slack's per-event `action_token`,
 *                                     required for bot-token search
 * @param {number}  ttlMs              how long it stays valid
 * @returns {string|null} the token, or null if the feature isn't configured
 */
export function mintCapability({ channelId, isPrivate, actionToken = null }, ttlMs) {
  const key = signingKey();
  if (!key) return null;

  const payload = b64url(
    JSON.stringify({
      ch: channelId,
      priv: Boolean(isPrivate),
      at: actionToken || undefined,
      exp: Math.floor((Date.now() + ttlMs) / 1000),
    }),
  );
  const sig = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return `v1.${payload}.${sig}`;
}

/**
 * Verifies a capability and returns its claims.
 *
 * Throws — rather than returning null — because every failure here is something
 * the endpoint should turn into a 401 with a distinct reason, and an expired
 * token (the normal, boring case, and now the expected one: the sandbox is
 * per-thread and long-lived, so a capability minted for an earlier turn can
 * still be replayed out of its session transcript, dead) reads very differently
 * in the logs from a bad signature (someone poking the endpoint).
 *
 * @returns {{channelId: string, isPrivate: boolean, actionToken: string|null}}
 */
export function verifyCapability(token) {
  const key = signingKey();
  if (!key) throw new Error("proxy is not configured");
  if (typeof token !== "string") throw new Error("missing capability");

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("malformed capability");

  const [, payload, sig] = parts;
  const expected = crypto.createHmac("sha256", key).update(payload).digest("base64url");

  // Length-checked first: timingSafeEqual throws outright on a length mismatch,
  // which would surface as a 500 rather than the 401 this deserves.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("bad signature");
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("malformed claims");
  }

  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error("expired capability");
  if (!claims.ch) throw new Error("capability names no channel");

  return {
    channelId: claims.ch,
    isPrivate: Boolean(claims.priv),
    actionToken: claims.at || null,
  };
}
