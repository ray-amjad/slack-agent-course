import { CLAUDE_DIR } from "./sandbox-guardrails.js";

/**
 * Read-merge-write for the sandbox's `~/.claude/settings.json`.
 *
 * WHY THIS EXISTS. This file used to be written whole, by `setUpGithub`, and only
 * on runs that happened to hold a GitHub token. Both halves of that are now
 * wrong. Memory has to configure `autoMemoryEnabled` on EVERY run — including,
 * especially, the runs where it is being turned off — and it has to do so
 * without discarding the hooks block, which is the other thing living in here.
 *
 * WHY MERGE RATHER THAN OVERWRITE. Claude Code edits this file itself while it
 * runs (curating memory is one of the things that does it), and other features
 * write to it too. On a container thrown away after every reply, overwriting was
 * nearly free to get wrong: we wrote first, once, and the worst it could destroy
 * was whatever the image shipped. The box now lives for the whole thread, so the
 * file we open at the start of turn 2 is the one the agent edited during turn 1 —
 * plus the hooks block an earlier turn merged in. Overwriting would roll all of
 * that back, silently, once per message.
 *
 * User scope, not project scope. A project-scoped `autoMemoryDirectory` is only
 * honoured after a workspace-trust prompt, and a headless sandbox has no way to
 * answer one.
 */

const SETTINGS_PATH = `${CLAUDE_DIR}/settings.json`;

/**
 * Keys stripped on every merge, whatever the incoming patch says.
 *
 * `apiKeyHelper` is here because of a real outage: a stale template shipped one,
 * it took precedence over CLAUDE_CODE_OAUTH_TOKEN, and every run died with
 * "Invalid API key". The old whole-file write made that impossible by accident;
 * now that we merge, it becomes possible again unless we say otherwise. This
 * line is what keeps a fix from silently regressing.
 */
const FORBIDDEN_KEYS = ["apiKeyHelper"];

/**
 * Merges `patch` into the sandbox's settings file and writes it back.
 *
 * A key whose patch value is `undefined` is DELETED rather than set — that is
 * how memory removes a stale `autoMemoryDirectory` when it disables itself,
 * instead of leaving the setting pointing at a directory that no longer means
 * anything.
 *
 * Best-effort, like everything else on this path: a settings write that fails is
 * logged and swallowed. The consequence is a run with default settings, not a
 * Slack message that never gets answered.
 *
 * @param {import('e2b').Sandbox} sandbox
 * @param {Record<string, unknown>} patch
 */
export async function mergeSettings(sandbox, patch) {
  let current = {};
  try {
    const raw = await sandbox.files.read(SETTINGS_PATH);
    const parsed = JSON.parse(raw);
    // Anything that isn't a plain object (an array, `null`, a bare string) is
    // not settings we can merge into, so start clean rather than spreading it.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed;
    }
  } catch {
    // Absent on a newly created sandbox — so on a thread's first message, and
    // never again after it, since the file we write here now survives the
    // pause. Unparseable means something else already broke it. Either way an
    // empty base is correct.
  }

  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  for (const key of FORBIDDEN_KEYS) delete next[key];

  try {
    await sandbox.files.write(SETTINGS_PATH, JSON.stringify(next, null, 2));
  } catch (err) {
    console.error("writing settings.json failed:", err.message);
  }
}
