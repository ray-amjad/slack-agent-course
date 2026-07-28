import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

/**
 * What the model is told about a thread. Slack is faked at `globalThis.fetch`,
 * the same seam test/slack-read.test.js uses, with a thread long enough to need
 * more than one page, because a single capped call returns the OLDEST messages.
 */

const THREAD_LENGTH = 450;
const ts = (i) => `1721304000.${String(i).padStart(6, "0")}`;
const thread = Array.from({ length: THREAD_LENGTH }, (_, i) => ({
  ts: ts(i + 1),
  user: "U1",
  text: `message ${i + 1}`,
}));

let slack;

before(async () => {
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  globalThis.fetch = async (_url, init) => {
    const params = new URLSearchParams(init.body);
    const start = Number(params.get("cursor") || 1);
    const limit = Number(params.get("limit"));
    const page = thread.slice(start, start + limit - 1);
    const next = start + page.length;
    const more = next < thread.length;
    return new Response(
      JSON.stringify({
        ok: true,
        // Slack repeats the root at the top of every page.
        messages: [thread[0], ...page],
        has_more: more,
        response_metadata: { next_cursor: more ? String(next) : "" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  slack = await import("../lib/slack.js");
});

describe("fetchThreadReplies", () => {
  it("reads to the end of a long thread, with the root once", async () => {
    const messages = await slack.fetchThreadReplies({ channel: "C1", threadTs: ts(1) });
    assert.equal(messages.length, THREAD_LENGTH);
    assert.equal(messages[0].text, "message 1");
    assert.equal(messages.at(-1).text, `message ${THREAD_LENGTH}`);
  });
});

describe("botOwnsThread", () => {
  it("sees a bot that joined after the first page", async () => {
    thread[THREAD_LENGTH - 1] = { ...thread[THREAD_LENGTH - 1], user: "UBOT" };
    const messages = await slack.fetchThreadReplies({ channel: "C1", threadTs: ts(1) });
    assert.equal(slack.botOwnsThread(messages, "UBOT"), true);
    thread[THREAD_LENGTH - 1] = { ...thread[THREAD_LENGTH - 1], user: "U1" };
  });
});

describe("renderTranscript", () => {
  it("returns a short thread whole, with no marker", () => {
    const out = slack.renderTranscript(thread.slice(0, 5), { botUserId: "UBOT" });
    assert.equal(out.split("\n").length, 5);
    assert.doesNotMatch(out, /left out/);
  });

  it("keeps the first and the newest of a long thread, and says what it dropped", () => {
    const out = slack.renderTranscript(thread, { botUserId: "UBOT" });
    const lines = out.split("\n");
    assert.match(lines[0], /message 1$/);
    assert.match(lines.at(-1), new RegExp(`message ${THREAD_LENGTH}$`));

    const marker = lines[1].match(/^\[(\d+) message\(s\) left out here\]$/);
    assert.ok(marker, "the second line says how many were left out");
    assert.equal(Number(marker[1]) + lines.length - 1, THREAD_LENGTH);
    assert.ok(out.length <= 6100);
  });

  it("cuts one huge message instead of letting it spend the budget", () => {
    const huge = [thread[0], { ...thread[1], text: "x".repeat(20000) }, thread[2]];
    const out = slack.renderTranscript(huge, { botUserId: "UBOT" });
    assert.match(out, /\[cut\]/);
    assert.match(out, /message 3$/);
  });
});

describe("threadWindow", () => {
  it("answers the root and the newest, then walks back to the start", () => {
    const seen = new Set();
    let before;
    do {
      const page = slack.threadWindow(thread, { limit: 50, before });
      assert.equal(page.messages[0].text, "message 1");
      for (const m of page.messages) seen.add(m.ts);
      before = page.nextBefore;
    } while (before);
    assert.equal(seen.size, THREAD_LENGTH);
  });
});
