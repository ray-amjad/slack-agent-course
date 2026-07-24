import crypto from "node:crypto";

const APP_ID = process.env.GITHUB_APP_ID;
const INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID;
const PRIVATE_KEY_B64 = process.env.GITHUB_APP_PRIVATE_KEY;

// GitHub's REST API is date-versioned. 2022-11-28 is what an unversioned request
// still defaults to and is supported until 10 March 2028; the newest version at
// time of writing is 2026-03-10. Pinning explicitly (rather than omitting the
// header) means a future change to the default can't move this endpoint under us.
// https://docs.github.com/en/rest/about-the-rest-api/api-versions
const API_VERSION = "2022-11-28";

/**
 * Mints a short-lived GitHub App installation token for one Slack request.
 *
 * This runs in the Vercel function and NEVER in the sandbox. The App private key
 * mints capabilities; the token IS a capability, scoped and expiring. Sending the
 * key into a sandbox that runs arbitrary model-authored code would collapse that
 * distinction, which is the whole reason this file exists.
 */

/** True once all three GitHub App vars are present — i.e. the feature is on. */
export function isConfigured() {
  return Boolean(APP_ID && INSTALLATION_ID && PRIVATE_KEY_B64);
}

/**
 * The private key, decoded. The env var holds the `.pem` base64-encoded on a
 * single line because multiline secrets don't survive env var handling intact.
 * The explicit `-----BEGIN` check exists because feeding base64 straight to
 * createSign fails with `error:1E08010C:DECODER routines::unsupported`, which
 * names neither the variable nor the encoding.
 */
function privateKey() {
  const decoded = Buffer.from(PRIVATE_KEY_B64, "base64").toString("utf8");
  if (!decoded.startsWith("-----BEGIN")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY did not decode to a PEM — it must hold the App's .pem base64-encoded on one line, not the raw key",
    );
  }
  return decoded;
}

const b64url = (input) => Buffer.from(input).toString("base64url");

/**
 * A signed RS256 JWT proving we are the App. Fifteen lines of node:crypto instead
 * of a JWT dependency: this repo has already been bitten once by an ESM-only
 * package breaking Vercel's bundler, and a JWT is three base64url segments.
 *
 * `iat` sits 60s in the past because GitHub rejects future-dated JWTs outright
 * and a slightly fast clock is otherwise indistinguishable from a forgery. `exp`
 * is under the documented 10-minute ceiling — this token lives for one request.
 */
function appJwt(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: APP_ID }),
  );
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(key)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Exchanges the App JWT for an installation token.
 *
 * The token is valid for one hour — fixed, not extendable, and far longer than
 * the sandbox it's handed to. Returns `{ token, expiresAt }`; throws on any
 * failure so the caller can fall back to a run without GitHub access.
 *
 * Nothing here logs, measures, or inspects the token: its format is GitHub's to
 * change, and the surest way not to leak a secret is never to handle it twice.
 */
export async function mintInstallationToken() {
  if (!isConfigured()) {
    throw new Error(
      "GitHub App is not configured (GITHUB_APP_ID / GITHUB_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY)",
    );
  }

  const res = await fetch(
    `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt(privateKey())}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "joestar-agent",
      },
    },
  );

  if (!res.ok) {
    // GitHub's own message is the useful half: 401 is a bad JWT or a skewed
    // clock, 404 is the wrong installation id. A failure body never carries a
    // token, so quoting it back is safe.
    const body = await res.text().catch(() => "");
    let message = body.slice(0, 200);
    try {
      message = JSON.parse(body).message ?? message;
    } catch {
      // non-JSON body (a gateway error page); the raw slice is what we have
    }
    throw new Error(`GitHub token request failed: HTTP ${res.status} — ${message}`);
  }

  const { token, expires_at: expiresAt } = await res.json();
  if (!token) throw new Error("GitHub token response contained no token");
  return { token, expiresAt };
}
