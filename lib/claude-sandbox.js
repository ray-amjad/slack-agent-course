import crypto from "node:crypto";

import { Sandbox } from "e2b";

import {
  CLAUDE_DIR,
  HOOK_PATH,
  HOOK_SCRIPT,
  SETTINGS_JSON,
} from "./sandbox-guardrails.js";
import { SANDBOX_CLAUDE_MD } from "./sandbox-memory.js";
import { buildSkillFiles } from "./sandbox-skills.js";

const TEMPLATE = process.env.E2B_TEMPLATE ?? "claude-code";

// Bound the run so we always have time left to post the answer back to Slack
// before Vercel terminates the function at maxDuration.
const RUN_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? 10 * 60 * 1000);

// How long a thread's sandbox may sit before E2B reclaims it, refreshed on
// every turn. This used to mean "kill it eagerly, E2B bills for the lifetime";
// now that the box outlives the run it is a BACKSTOP. We pause the sandbox
// ourselves the moment the turn ends — a paused sandbox bills no compute — so
// in the normal case this deadline never arrives. It is here for the run that
// dies without reaching that pause, and `lifecycle.onTimeout: "pause"` (see
// getOrCreateSandbox) means even then the thread loses time, not its
// transcript.
const SANDBOX_TIMEOUT_MS = RUN_TIMEOUT_MS + 60_000;

// The two well-known directories the Slack layer and the model agree on:
// attachments land in inputs before the run, anything the model wants to send
// back it drops into outputs. They used to be self-cleaning, because the whole
// container was. They are not any more — see the hygiene in runClaude and in
// the run script; a leftover here is turn 1's artifact re-uploaded on turn 2.
const INPUT_DIR = "/tmp/inputs";
const OUTPUT_DIR = "/tmp/outputs";

// User-level memory: loaded on every run regardless of where the agent happens
// to be standing, which is the whole point — project-level discovery walks up
// from cwd, and there is no project checked out in this container to walk up
// from. See lib/sandbox-memory.js.
const CLAUDE_MD_PATH = `${CLAUDE_DIR}/CLAUDE.md`;

// Cap how many output files we bother uploading — not a byte cap, since
// outputs now stream straight from the sandbox to Slack and never sit in
// this process's memory. Skip the rest (logged) rather than spamming the
// thread with an unbounded number of attachments.
const MAX_OUTPUT_FILES = 5;

// Bounds a single file's direct-to-Slack upload, separate from RUN_TIMEOUT_MS
// since it happens after Claude's own run has already finished.
const UPLOAD_TIMEOUT_MS = Number(process.env.CLAUDE_UPLOAD_TIMEOUT_MS ?? 2 * 60 * 1000);

// A fixed namespace for the UUIDv5 below. Any constant UUID does; it is there
// so ids derived here can't collide with ids someone derives from the same
// channel/thread string for a different purpose.
const SESSION_NAMESPACE = "6c9e3a1f-8b2d-4f7a-9c31-5a0e7d24b18f";

// Exit code the run script uses for "another turn already holds the lock".
// 75 is EX_TEMPFAIL from sysexits.h — a conventional "try again later" that
// nothing else in the pipeline returns, so it can never be mistaken for a real
// failure out of claude.
const BUSY_EXIT_CODE = 75;

// Postgres and Redis are baked into the template and already running by the
// time Sandbox.create resolves — see e2b/template.js. They keep running across
// the pause between turns: `Sandbox.pause` snapshots memory by default
// (`keepMemory: true`), so a resumed box comes back with its processes, its
// connections and — the part that actually matters to the agent — whatever it
// wrote into that database last turn. Passing `keepMemory: false` would
// cold-boot the box instead and quietly break that.
//
// These are passed per command for the same reason the OAuth token is: envs set
// at Sandbox.create never reach the processes commands.run spawns. Without them
// the agent has a database it has no way to guess the DSN for.
const DATABASE_URL =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://user:postgres@localhost:5432/app";
const REDIS_URL = process.env.SANDBOX_REDIS_URL ?? "redis://localhost:6379";

// psql with no arguments defaults its database name to the OS user (`user`),
// which doesn't exist as a database — so without this a bare `psql` greets the
// agent with `FATAL: database "user" does not exist`. Pointing PGDATABASE at
// the one database we actually created makes the obvious command work.
const PGDATABASE = "app";

// Must match the path the template installed the browsers to. Playwright
// otherwise looks under $HOME (/home/user/.cache/ms-playwright), finds nothing,
// and asks the agent to download Chromium again mid-run. See e2b/template.js.
const PLAYWRIGHT_BROWSERS_PATH = "/ms-playwright";

// playwright and claude-code are installed with `npm -g`, and node does not look
// in the global module directory when resolving `require('playwright')` — only
// the `playwright` CLI ends up on PATH, not the library. Without this, a script
// the agent writes to drive a browser fails with ERR_MODULE_NOT_FOUND and it has
// to discover the global path for itself (a real smoke test did exactly that)
// or waste a run doing a local `npm install` of a package already in the image.
const NODE_PATH = "/usr/local/lib/node_modules";

// git refuses to commit without an identity, and the sandbox has none. The values
// are cosmetic — they appear as the commit author — so any default will do.
const GIT_USER_NAME = process.env.GIT_USER_NAME ?? "Joestar";
const GIT_USER_EMAIL =
  process.env.GIT_USER_EMAIL ?? "joestar@users.noreply.github.com";

// Exa's hosted MCP server (web search) works on its free tier with no key at
// all, so it's registered either way — the key just lifts the rate limit.
// The header value is the literal string "${EXA_API_KEY}", not the secret
// itself: Claude Code expands that placeholder from the process's own env
// when it connects the server, so the key never lands in ~/.claude.json on
// disk. Same reasoning as the GH_TOKEN credential helper below.
const EXA_API_KEY = process.env.EXA_API_KEY;
const EXA_SERVER_CONFIG = JSON.stringify(
  EXA_API_KEY
    ? {
        type: "http",
        url: "https://mcp.exa.ai/mcp",
        headers: { "x-api-key": "${EXA_API_KEY}" },
      }
    : { type: "http", url: "https://mcp.exa.ai/mcp" },
);
// Registered ONCE, when the box is created, rather than re-run on every turn.
// `claude mcp add-json --scope user` writes ~/.claude.json, and that file now
// survives the reply along with the rest of the sandbox. This used to be glued
// onto the front of the claude command itself — with a `; ` so a hiccup
// couldn't take down the run, and its output redirected away so plain text
// couldn't land in the middle of the stream-json pipe. Neither is needed once
// it is a command of its own: it can be allowed to fail on its own terms, and
// logged when it does.
//
// The cost of persistence: a box provisioned before EXA_API_KEY was set keeps
// its keyless registration for the life of the thread. Re-provisioning on a
// config change needs a version stamp on the box, which this repo doesn't have.
const EXA_SETUP_CMD = `claude mcp add-json exa --scope user '${EXA_SERVER_CONFIG}'`;

/**
 * The Claude Code session id for a Slack thread: a pure function of the thread,
 * stored nowhere.
 *
 * `claude --session-id` lets US choose the id rather than handing us one back,
 * and that is what removes the need for a database. Given a channel and a
 * thread timestamp we can always re-derive the same id, so a redeploy, a cold
 * function or a different region all land on the same session.
 *
 * It has to be a valid UUID or the CLI rejects it, hence the v5 shape: SHA-1
 * over a fixed namespace plus the name, with the version and variant bits
 * stamped in per RFC 4122. That is all `uuid`'s v5 does for our purposes, so we
 * don't take the dependency for it.
 */
export function sessionIdFor(channelId, threadTs) {
  const namespace = Buffer.from(SESSION_NAMESPACE.replace(/-/g, ""), "hex");
  const bytes = crypto
    .createHash("sha1")
    .update(namespace)
    .update(`${channelId}:${threadTs}`)
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Raised when this thread's sandbox is already running a turn.
 *
 * Its own type so the Slack layer can say "I'm still working on your last
 * message" instead of rendering a failure. Nothing failed: the request simply
 * arrived while the previous one was still going.
 */
export class BusyError extends Error {
  constructor() {
    super("a turn is already running in this thread's sandbox");
    this.name = "BusyError";
  }
}

/**
 * This thread's sandbox — found and resumed, or created.
 *
 * There is no database here either. The lookup key is the sandbox's own
 * METADATA, which `Sandbox.list` filters on and which matches PAUSED sandboxes
 * too — so a thread that has been quiet for an hour is found exactly like one
 * that replied a second ago.
 *
 * @returns {Promise<{sandbox: Sandbox, isNew: boolean}>} `isNew` is what the
 *          caller gates one-time provisioning on: a resumed box already has it.
 */
async function getOrCreateSandbox({ channelId, threadTs }) {
  const metadata = { slack_channel: channelId, slack_thread: threadTs };

  // `list` returns a PAGINATOR, not an array — `.nextItems()` is the first
  // page, and one page is plenty: a thread should have exactly one sandbox.
  const matches = await Sandbox.list({ query: { metadata } }).nextItems();

  if (!matches.length) {
    const sandbox = await Sandbox.create(TEMPLATE, {
      metadata,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      // Not decoration. The default is "kill", which would DESTROY the session
      // transcript — the thread's entire memory — the first time a box sat idle
      // past its deadline. Pausing keeps the disk, so the worst an expiry can
      // do is make the next turn slower.
      lifecycle: { onTimeout: "pause" },
    });
    return { sandbox, isNew: true };
  }

  // Metadata is a filter, not a unique key, so two mentions arriving in one
  // thread at the same moment can both miss the lookup above and both create a
  // box. Converge on the OLDEST, always: it is the one holding the session
  // transcript, and "oldest" is a decision every turn makes the same way
  // without coordinating. The others are left alone rather than killed — one
  // may be mid-turn — and park themselves when their own timeout fires.
  const [oldest, ...rest] = [...matches].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );
  if (rest.length) {
    const ignored = rest.map((s) => s.sandboxId).join(", ");
    console.warn(
      `thread has ${matches.length} sandboxes; using ${oldest.sandboxId}, ignoring ${ignored}`,
    );
  }

  // connect() RESUMES a paused sandbox — that is the entire restore path, and
  // it is also why stopping one must never go through connect() (see the
  // `finally` in runClaude). Passing timeoutMs is not optional: connect's own
  // default is five minutes, which would park the box mid-run.
  const sandbox = await Sandbox.connect(oldest.sandboxId, {
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });
  return { sandbox, isNew: false };
}

/**
 * The shell wrapper around `claude`, and the only place that knows the sandbox
 * now outlives the turn. Three jobs:
 *
 * 1. ONE TURN AT A TIME. Two `--resume` runs against the same session interleave
 *    their writes and corrupt the transcript permanently — a thread's whole
 *    memory, unrepairable. `flock -n` takes the lock or gives up immediately.
 *    Immediately, not queued: this function is awaited inside a Slack event
 *    handler, so waiting for the lock would just burn the caller's maxDuration
 *    and time out anyway. Losing the race is reported, not waited out.
 * 2. FIRST TURN OR RESUME. The ground truth is the transcript file itself, not a
 *    marker we maintain: if claude already has a session file for this id,
 *    resume it, otherwise create it. The `*` is deliberate — the directory under
 *    ~/.claude/projects is derived from claude's working directory, which `-p`
 *    picks for us, so we match on the id and let the path be whatever it is.
 * 3. HYGIENE. /tmp/outputs is emptied here, inside the lock, rather than before
 *    the run: a turn that loses the race must not delete the files the winning
 *    turn is busy producing.
 *
 * The session id rides in as an env var rather than being interpolated, for the
 * same reason the prompt is piped from a file — the shell only ever sees a fixed
 * string.
 */
function runScript({ claudeArgs }) {
  return `
exec 9>/tmp/turn.lock
flock -n 9 || exit ${BUSY_EXIT_CODE}

rm -rf ${OUTPUT_DIR}
mkdir -p ${OUTPUT_DIR}

SESSION_FLAG=--session-id
ls ~/.claude/projects/*/"$JOESTAR_SESSION_ID".jsonl >/dev/null 2>&1 && SESSION_FLAG=--resume

cat /tmp/prompt.txt | claude -p ${claudeArgs} "$SESSION_FLAG" "$JOESTAR_SESSION_ID"
`;
}

/**
 * Runs one prompt through Claude Code in this THREAD's sandbox — created on the
 * first message, resumed on every one after it, and paused in between.
 *
 * @param {object}   opts
 * @param {string}   opts.prompt      the (already-assembled) prompt text
 * @param {string}   opts.channelId   the Slack channel this run belongs to
 * @param {string}   opts.threadTs    the thread it is answering in. Together
 *                                    with channelId this is the whole state
 *                                    store: it names the sandbox (metadata) and
 *                                    derives the session id.
 * @param {Array}    [opts.inputFiles] `{ name, data: Buffer }` attachments to
 *                                     drop into /tmp/inputs before the run
 * @param {string}   [opts.githubToken] a GitHub App installation token, minted
 *                                     for this request and dead within the hour
 * @param {function} [opts.onProgress] called with `{ name, input }` each time
 *                                     Claude starts a new tool call, so the
 *                                     caller can show live progress
 * @param {function} [opts.onOutputFile] called once per file left in
 *                                     /tmp/outputs, as `{ filename, length }`
 *                                     (no bytes). Must return/resolve to
 *                                     `{ uploadUrl, fileId }` — typically
 *                                     `lib/slack.js`'s `mintUploadURL`. The
 *                                     sandbox POSTs that file's bytes directly
 *                                     to `uploadUrl`; this function's own
 *                                     memory never holds them. Omit to skip
 *                                     uploading outputs entirely.
 * @returns {Promise<{text, costUsd, sessionId, uploadedFiles}>} uploadedFiles
 *          is `{ name, fileId }[]` for whatever the sandbox actually
 *          finished POSTing — the caller still owes Slack a
 *          `completeUploadExternal` call to finalize and share them.
 * @throws {BusyError} if a turn is already running in this thread's sandbox
 *
 * Auth note: we pass CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_API_KEY, so the run
 * bills against a Claude subscription instead of API credit. That token is also
 * why `--bare` is absent below — bare mode deliberately skips OAuth and would
 * leave the CLI unauthenticated.
 */
export async function runClaude({
  prompt,
  channelId,
  threadTs,
  inputFiles = [],
  githubToken = null,
  onProgress,
  onOutputFile,
}) {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not set");
  if (!channelId || !threadTs) {
    throw new Error("runClaude needs channelId and threadTs to find its sandbox");
  }

  const sessionId = sessionIdFor(channelId, threadTs);
  const { sandbox, isNew } = await getOrCreateSandbox({ channelId, threadTs });

  // Set when this turn bounced off the lock. The teardown below then has to
  // keep its hands off the box: it belongs to the turn still running in it, and
  // pausing it would suspend that run mid-answer.
  let busy = false;

  try {
    // Empty this turn's inbox before filling it. On a throwaway container the
    // directory was new every time; on a box that survives the reply, turn 1's
    // attachments would otherwise still be sitting there on turn 2, alongside
    // (or overwriting) the ones this turn is about to write.
    //
    // /tmp/outputs gets the same treatment inside the run script — see there for
    // why that one has to happen under the lock and this one can't.
    await sandbox.commands.run(`rm -rf ${INPUT_DIR} && mkdir -p ${INPUT_DIR}`);

    // Deliberately not folded into setUpGithub: who JoeStar is has nothing to
    // do with whether this run happens to hold a GitHub token. Provision-once,
    // because the file's contents are a constant in this repo — nothing about
    // it varies per turn, so rewriting identical bytes on every message would
    // be pure latency. The cost of that choice: a box provisioned before a
    // deploy keeps the OLD persona for the life of its thread. Acceptable for
    // now; the fix is a version stamp on the box, which we haven't built.
    if (isNew) {
      // makeDir is a no-op when the directory already exists, so this stays
      // safe alongside the hooks dir setUpGithub creates below.
      await sandbox.files.makeDir(CLAUDE_DIR);
      await sandbox.files.write(CLAUDE_MD_PATH, SANDBOX_CLAUDE_MD);

      // The toolkit skills, installed user-level for the same reason CLAUDE.md
      // is, and provision-once for the same reason too. Shipped from the
      // deployment rather than baked into the E2B template so editing a skill
      // is a git push, not a template rebuild — persisting them on the box
      // doesn't change that, it just moves the copy from every turn to the
      // first one. `files.write` creates parent directories on its own, so each
      // skill's folder needs no makeDir; one batched call keeps this to a
      // single round trip no matter how many skills there are.
      const skillFiles = buildSkillFiles();
      if (skillFiles.length) await sandbox.files.write(skillFiles);
    }

    // Attachments are binary and untrusted; write them as bytes, never as a
    // shell argument. A Blob avoids Buffer's shared-pool slicing surprises.
    if (inputFiles.length) {
      await sandbox.files.write(
        inputFiles.map((f) => ({
          path: `${INPUT_DIR}/${f.name}`,
          data: new Blob([f.data]),
        })),
      );
    }

    // The prompt is untrusted Slack input, so it never touches the command
    // line. Writing it to a file and piping it in means the shell only ever
    // sees a fixed string, and Claude reads the prompt from stdin.
    await sandbox.files.write("/tmp/prompt.txt", prompt);

    // Only when this run actually holds a token: no GitHub access, no git
    // identity, no push guard, nothing to explain away.
    if (githubToken) await setUpGithub(sandbox, { isNew });

    // Web search, once per box — see EXA_SETUP_CMD. Best-effort on purpose: a
    // failed registration costs the thread its search tool, never its answer.
    if (isNew) {
      await sandbox.commands
        .run(EXA_SETUP_CMD)
        .catch((err) =>
          console.error("exa mcp registration failed:", err.stderr || err.message),
        );
    }

    // stream-json (instead of the single-shot json format) makes Claude Code
    // print one JSON object per line as it works: a system init line, then an
    // interleaved "assistant"/"user" line per turn and tool result, then a
    // final "result" line with the same fields the old json format returned
    // in one shot. Consuming it line-by-line as it arrives — rather than
    // waiting for the whole run to finish — is what lets onProgress report a
    // tool call the moment it starts instead of only after everything is
    // over. The CLI requires --verbose alongside --output-format stream-json
    // in print mode; without it, it refuses to start.
    let stdoutBuf = "";
    let resultEvent = null;
    const consumeLine = (line) => {
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        return; // stray non-JSON output — never let it crash the run
      }
      if (evt.type === "result") {
        resultEvent = evt;
        return;
      }
      // The init line carries the skills Claude Code actually discovered on
      // disk, and it is emitted before the first API call — so this is the one
      // place that can distinguish "the toolkit shipped" from "the bundler
      // dropped it and the agent has been running without its skills for a
      // week". That distinction is invisible everywhere else: a missing skill
      // produces no error, just an agent that never reaches for it. It is
      // logged on every turn, not only the one that installed them, so it also
      // answers the question the pause introduces: did they survive the resume.
      if (evt.type === "system" && evt.subtype === "init") {
        console.log(`skills loaded in sandbox: ${(evt.skills ?? []).join(", ") || "(none)"}`);
        return;
      }
      if (evt.type !== "assistant" || !onProgress) return;
      for (const block of evt.message?.content ?? []) {
        if (block.type === "tool_use") onProgress({ name: block.name, input: block.input });
      }
    };
    const onStdout = (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line) consumeLine(line);
      }
    };

    // The OAuth token is passed HERE, per command — not at Sandbox.create.
    // E2B's create-time envs live on the client-side Sandbox object and do not
    // reach the process commands.run spawns, so a create-only token arrives
    // empty and Claude rejects the blank credential as "Invalid API key". This
    // is the load-bearing line for auth. (Lesson copied from percy-agent.)
    //
    // requestTimeoutMs: 0 disables the SDK's own request timeout so only our
    // RUN_TIMEOUT_MS bounds the run. On a non-zero exit e2b throws a
    // CommandExitError carrying stdout/stderr — surface that, since bare
    // "exit status 1" says nothing about why claude failed.
    let result;
    try {
      result = await sandbox.commands.run(
        runScript({
          claudeArgs:
            "--output-format stream-json --verbose --dangerously-skip-permissions",
        }),
        {
          envs: {
            CLAUDE_CODE_OAUTH_TOKEN: token,
            JOESTAR_SESSION_ID: sessionId,
            DATABASE_URL,
            REDIS_URL,
            PGDATABASE,
            PLAYWRIGHT_BROWSERS_PATH,
            NODE_PATH,
            // Only needed if the config above embedded the placeholder, but
            // harmless to set otherwise. Still passed on EVERY turn, not just
            // the one that registered the server: the value lives in this env,
            // never in ~/.claude.json, so a resumed box has no copy of its own.
            ...(EXA_API_KEY ? { EXA_API_KEY } : {}),
            // GH_TOKEN is what the `gh` CLI reads on its own — no `gh auth
            // login`, which wants a TTY the sandbox doesn't have. Everything
            // Claude spawns inherits it, which is exactly what makes git and gh
            // work and exactly why any code the model runs can read it too.
            // HISTFILE keeps it out of shell history at least.
            ...(githubToken
              ? { GH_TOKEN: githubToken, HISTFILE: "/dev/null" }
              : {}),
          },
          timeoutMs: RUN_TIMEOUT_MS,
          requestTimeoutMs: 0,
          onStdout,
        },
      );
    } catch (err) {
      // The one exit code that isn't a failure: another turn holds this
      // thread's lock. Distinguishable on purpose, so the Slack layer can say
      // so rather than posting a warning with someone else's stack trace.
      if (err.exitCode === BUSY_EXIT_CODE) {
        busy = true;
        throw new BusyError();
      }
      const detail = (err.stderr || err.stdout || "").trim();
      console.error("claude exited non-zero:", {
        exitCode: err.exitCode,
        stderr: err.stderr,
        stdout: err.stdout,
      });
      throw new Error(detail ? detail.slice(0, 1500) : err.message);
    }

    if (stdoutBuf.trim()) consumeLine(stdoutBuf.trim());

    const parsed = parseResult(resultEvent);
    // Upload outputs after a successful run — a failed run threw above. Only
    // happens if the caller wired up onOutputFile; otherwise there's nothing
    // to mint upload URLs with.
    parsed.uploadedFiles = onOutputFile ? await uploadOutputs(sandbox, onOutputFile) : [];
    return parsed;
  } finally {
    // PAUSE, don't kill. The conversation lives on this box's filesystem — the
    // session transcript claude just wrote is the thread's memory, and killing
    // the sandbox would throw it away as surely as deleting the messages. A
    // paused sandbox bills no compute and wakes in a couple of seconds, so
    // there is nothing to gain by destroying it.
    //
    // BY ID, never through a fresh connect(): connect() RESUMES a paused box,
    // so a "stop" that connected first would wake a sandbox up in order to put
    // it to sleep. We already hold a live handle here; all we want off it is
    // its id.
    //
    // No `keepMemory: false` — the default snapshots RAM, which is what keeps
    // the box's running services (Postgres, Redis) alive across turns instead
    // of cold-booting them on every resume.
    //
    // Skipped when this turn lost the lock — see `busy` above.
    if (!busy) {
      // Don't let a teardown failure mask a real error from the run above.
      await Sandbox.pause(sandbox.sandboxId).catch((err) =>
        console.error("sandbox.pause failed:", err),
      );
    }
  }
}

/**
 * Prepares the sandbox for GitHub work: the push guard, and a git that can
 * authenticate without ever storing the token.
 *
 * The credential helper is the load-bearing part. `git` ignores GH_TOKEN — only
 * `gh` reads that — so without a helper every push prompts for a password it
 * will never get. What lands in ~/.gitconfig is the literal string `$GH_TOKEN`,
 * expanded by the shell only when git invokes the helper, so the token is in no
 * file and in no argv. The alternatives both leak it: baking it into the remote
 * URL leaves it in .git/config in plaintext — and the box is per-thread now, so
 * that is the rest of the CONVERSATION, not the rest of the run — and passing it
 * as an argument puts it in `ps`.
 *
 * `gh auth setup-git` is the other way to do this and it does work on current gh
 * (2.95) with env-var auth, writing a helper that shells back into `gh`. This
 * one is preferred because it doesn't care which gh version apt happened to
 * install, or whether gh is present at all.
 *
 * Split in two now that the sandbox survives the turn. The hook and its
 * settings file are CONTENT: writing them again on turn 7 would upload the same
 * bytes to the same paths, so they are gated on `isNew`. The git config is not
 * gated, and that is a decision rather than an oversight — it costs one command,
 * and the thread's FIRST message may well have arrived without a GitHub token
 * (the App unconfigured, or the mint having failed), leaving a box that has
 * never been configured for git. Re-running it makes "did an earlier turn do
 * this?" a question nobody has to answer.
 *
 * Nothing here needs redoing when the token rotates: the helper stores the
 * literal `$GH_TOKEN`, and each turn's `commands.run` supplies that hour's value.
 */
async function setUpGithub(sandbox, { isNew }) {
  if (isNew) {
    await sandbox.files.makeDir(`${CLAUDE_DIR}/hooks`);
    await sandbox.files.write([
      { path: HOOK_PATH, data: HOOK_SCRIPT },
      { path: `${CLAUDE_DIR}/settings.json`, data: SETTINGS_JSON },
    ]);
  }

  const setup = [
    'git config --global user.name "$GIT_USER_NAME"',
    'git config --global user.email "$GIT_USER_EMAIL"',
    // Scoped to github.com so the token is offered to that host and nowhere else.
    `git config --global credential.https://github.com.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`,
  ].join(" && ");

  await sandbox.commands.run(setup, {
    envs: { GIT_USER_NAME, GIT_USER_EMAIL },
  });
}

/**
 * Lists whatever the model left in /tmp/outputs and, for each file (up to
 * MAX_OUTPUT_FILES), mints an upload URL via `onOutputFile` and has the
 * sandbox itself POST the bytes straight to Slack. The bytes never pass
 * through this process — only the filename and size do, to mint the URL.
 *
 * A file whose POST fails (bad mint, network blip, Slack error) is logged
 * and dropped rather than failing the whole run; its mint is simply never
 * completed and Slack discards it on its own.
 */
async function uploadOutputs(sandbox, onOutputFile) {
  let entries;
  try {
    entries = await sandbox.files.list(OUTPUT_DIR);
  } catch (err) {
    console.error("listing outputs failed:", err.message);
    return [];
  }

  const files = entries.filter((e) => e.type === "file");
  if (files.length > MAX_OUTPUT_FILES) {
    console.warn(`outputs: ${files.length} files, only first ${MAX_OUTPUT_FILES} sent`);
  }

  const uploaded = [];
  for (const entry of files.slice(0, MAX_OUTPUT_FILES)) {
    try {
      const { uploadUrl, fileId } = await onOutputFile({
        filename: entry.name,
        length: entry.size,
      });
      // Both values ride in via envs, not string interpolation, so a
      // filename or URL can't break out into shell syntax — same reasoning
      // as GH_TOKEN above. `-f` turns a non-200 response into a nonzero exit
      // so a failed POST throws instead of silently completing an empty
      // upload.
      await sandbox.commands.run(
        'curl -sS -f -X POST -F filename=@"$JOESTAR_OUTPUT_PATH" "$JOESTAR_UPLOAD_URL"',
        {
          envs: { JOESTAR_OUTPUT_PATH: entry.path, JOESTAR_UPLOAD_URL: uploadUrl },
          timeoutMs: UPLOAD_TIMEOUT_MS,
          requestTimeoutMs: 0,
        },
      );
      uploaded.push({ name: entry.name, fileId });
    } catch (err) {
      console.error(`uploading output ${entry.name} failed:`, err.stderr || err.message);
    }
  }
  return uploaded;
}

/**
 * The stream's final line has type "result" and carries the same fields the
 * old single-shot `--output-format json` response did. No such line means the
 * stream ended (successful exit code and all) without ever producing one —
 * itself a failure worth surfacing rather than returning empty text.
 */
function parseResult(resultEvent) {
  if (!resultEvent) {
    throw new Error("Claude Code stream ended without a result event");
  }

  if (resultEvent.is_error) {
    throw new Error(resultEvent.result ?? "Claude Code reported an error");
  }

  return {
    text: resultEvent.result ?? "",
    costUsd: resultEvent.total_cost_usd,
    sessionId: resultEvent.session_id,
  };
}
