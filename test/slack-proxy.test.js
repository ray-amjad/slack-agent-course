import assert from "node:assert/strict";
import crypto from "node:crypto";
import { before, describe, it } from "node:test";

/**
 * The capability token and the guards on the endpoint that spends it.
 *
 * No network: every case here is either pure crypto or a request the handler
 * rejects before it would have called Slack. The other file
 * (slack-read.test.js) covers the paths that do reach the API.
 *
 * Everything is imported dynamically. `lib/slack.js` builds its WebClient at
 * module load from `process.env.SLACK_BOT_TOKEN`, and static imports are
 * evaluated before any of this file's own statements run — so a top-level
 * `import` would construct that client before the env below exists.
 */

const SIGNING_SECRET = "test-signing-secret";

let mintCapability;
let verifyCapability;
let isConfigured;
let proxyUrl;
let handler;

before(async () => {
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
  process.env.SLACK_BOT_TOKEN = "xoxb-fake";
  process.env.JOESTAR_PUBLIC_URL = "https://joestar-agent.test";
  delete process.env.JOESTAR_PROXY_SECRET;

  ({ mintCapability, verifyCapability, isConfigured, proxyUrl } = await import(
    "../lib/slack-proxy.js"
  ));
  ({ default: handler } = await import("../api/sandbox/slack.js"));
});

/** Drives the handler with a fake req/res pair and resolves its response. */
function invoke({ method = "POST", capability, body } = {}) {
  const req = {
    method,
    headers: capability ? { authorization: `Bearer ${capability}` } : {},
    on(event, cb) {
      if (event === "data" && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
      if (event === "end") cb();
      return this;
    },
  };
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      setHeader() {},
      end(payload) {
        resolve({ status: res.statusCode, body: payload ? JSON.parse(payload) : null });
      },
    };
    handler(req, res);
  });
}

describe("capability round-trip", () => {
  it("is configured from a signing secret and a public url", () => {
    assert.ok(isConfigured());
    assert.equal(proxyUrl(), "https://joestar-agent.test/api/sandbox/slack");
  });

  it("carries its claims through mint and verify", () => {
    const token = mintCapability(
      { channelId: "C123", isPrivate: false, actionToken: "act.123" },
      60_000,
    );
    assert.ok(token.startsWith("v1."));

    const claims = verifyCapability(token);
    assert.equal(claims.channelId, "C123");
    assert.equal(claims.isPrivate, false);
    assert.equal(claims.actionToken, "act.123");
  });

  it("normalises a missing action token to null", () => {
    const claims = verifyCapability(mintCapability({ channelId: "G9", isPrivate: true }, 60_000));
    assert.equal(claims.isPrivate, true);
    assert.equal(claims.actionToken, null);
  });
});

describe("capability tampering", () => {
  const forge = (token, mutate) => {
    const [, payload, sig] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    mutate(claims);
    return `v1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`;
  };

  it("rejects a sandbox that widens its own access", () => {
    // The attack the tier rule exists to stop: claim the run is private, and a
    // public-channel run could read every private channel the bot is in.
    const token = mintCapability({ channelId: "C1", isPrivate: false }, 60_000);
    const forged = forge(token, (c) => {
      c.priv = true;
    });
    assert.throws(() => verifyCapability(forged), /bad signature/);
  });

  it("rejects a truncated signature without throwing from timingSafeEqual", () => {
    const token = mintCapability({ channelId: "C1" }, 60_000);
    assert.throws(() => verifyCapability(token.slice(0, -4)), /bad signature/);
  });

  it("rejects garbage, wrong versions and absent tokens", () => {
    assert.throws(() => verifyCapability("nope"), /malformed/);
    assert.throws(() => verifyCapability("v2.a.b"), /malformed/);
    assert.throws(() => verifyCapability(undefined), /missing/);
  });

  it("rejects an expired capability", () => {
    assert.throws(() => verifyCapability(mintCapability({ channelId: "C1" }, -1000)), /expired/);
  });

  it("does not accept a token signed with the raw signing secret", () => {
    // Proves the HMAC label in slack-proxy.js actually separates this key from
    // the one Slack request verification uses.
    const [, payload] = mintCapability({ channelId: "C1" }, 60_000).split(".");
    const sig = crypto.createHmac("sha256", SIGNING_SECRET).update(payload).digest("base64url");
    assert.throws(() => verifyCapability(`v1.${payload}.${sig}`), /bad signature/);
  });
});

describe("endpoint guards", () => {
  const valid = () => mintCapability({ channelId: "C1", isPrivate: false }, 60_000);

  it("refuses anything but POST", async () => {
    assert.equal((await invoke({ method: "GET" })).status, 405);
  });

  it("refuses missing, malformed and expired capabilities", async () => {
    const body = { action: "channels" };
    assert.equal((await invoke({ body })).status, 401);
    assert.equal((await invoke({ capability: "v1.aaa.bbb", body })).status, 401);
    assert.equal(
      (await invoke({ capability: mintCapability({ channelId: "C1" }, -1), body })).status,
      401,
    );
  });

  it("does not tell a prober which part of its token was wrong", async () => {
    const { body } = await invoke({ capability: "v1.aaa.bbb", body: { action: "channels" } });
    assert.equal(body.error, "invalid or expired capability");
  });

  it("rejects unknown actions", async () => {
    const { status, body } = await invoke({ capability: valid(), body: { action: "post" } });
    assert.equal(status, 400);
    assert.match(body.error, /unknown action/);
  });

  it("rejects actions missing their arguments", async () => {
    const capability = valid();
    for (const body of [
      { action: "history" },
      { action: "thread", channel: "C1" },
      { action: "search" },
    ]) {
      assert.equal((await invoke({ capability, body })).status, 400, body.action);
    }
  });

  it("explains a search with no action token rather than failing opaquely", async () => {
    const capability = mintCapability({ channelId: "C1", isPrivate: true }, 60_000);
    const { status, body } = await invoke({ capability, body: { action: "search", query: "x" } });
    assert.equal(status, 409);
    assert.match(body.error, /@mentions Joestar/);
  });
});
