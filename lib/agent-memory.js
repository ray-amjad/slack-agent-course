/**
 * Long-term memory: the git plumbing, and deliberately nothing else.
 *
 * WHAT THIS IS NOT. There is no recall endpoint here, no embedding store, no
 * database, and no step that loads memories into the prompt. Claude Code already
 * has an auto-memory feature that reads a `MEMORY.md` index at session start,
 * decides on its own what is worth keeping, writes topic files beside the index,
 * and compacts them when they grow. All of that is free and already tested. The
 * only thing it cannot do by itself is survive this architecture — so this file
 * supplies the two things it is missing: a directory that outlives the sandbox,
 * and a settings file pointing at it.
 *
 * WHY IT HAS TO BE GIT. `lib/claude-sandbox.js` gives each Slack THREAD its own
 * sandbox, so a note the agent writes to disk already survives to the next
 * message — but only within that one thread, and only for as long as that box
 * lives. The store has to be somewhere else for a fact learned in one thread to
 * reach another, or to outlive the box it was learned in. A clone pulled before
 * the agent starts and pushed after it stops is what turns "this thread" into
 * "this channel, forever". It also means a poisoned memory is a diffable,
 * revertable, attributable commit rather than a mystery row.
 *
 * THE ONE RULE. A memory failure must never cost a turn. Every export here is
 * best-effort: they log, they return outcomes, and they do not throw into the
 * caller's control flow. The corollary matters more than the rule — auto memory
 * defaults to ON, so a failure that merely returns early leaves the agent
 * cheerfully writing notes into a per-sandbox directory that nothing syncs.
 * They survive the turn, which makes it look like it works — and never leave
 * the thread, which is the only thing it exists for. That is why every failure path below reaches
 * `settingsPatch` with `enabled: false`, and why that function deletes
 * `autoMemoryDirectory` rather than leaving a stale one behind.
 */

// Under $HOME rather than /tmp, which is now load-bearing rather than merely
// tidy: the sandbox gained pause/resume, /tmp is cleared between turns, and a
// store living there would be re-cloned on every message — or, worse, lose an
// un-pushed commit that a failed push had left waiting for the next turn.
const STORE_DIR = "/home/user/.agent/memory";

// The workspace tier, read by every channel and written by public ones. Slack
// channel IDs are `[A-Z][A-Z0-9]+` and never begin with an underscore, so this
// cannot collide with a silo — but `channelDirName` re-checks anyway, because
// the cost of being wrong is pointing one channel's memory at another's.
const SHARED_DIR_NAME = "_shared";

// `owner/repo` of the private store. Unset is the kill switch: memory is
// skipped, the agent is otherwise untouched, and the settings file still says
// so explicitly.
const REPO_SLUG = process.env.AGENT_MEMORY_REPO;

// The whole sync, not one git step. Both entry points below run synchronously in
// front of a Slack reply — one before the agent spawns, one before the sandbox
// is paused — so they need a ceiling rather than whatever timeout git happens to
// pick. Out of budget is reported as a failure, so callers take their normal
// "that step didn't work" branch instead of hanging the turn.
const SYNC_BUDGET_MS = Number(process.env.AGENT_MEMORY_TIMEOUT_MS ?? 40_000);

// Cosmetic, but they must be passed at commit time rather than read from repo
// config: a box provisioned by an older deploy may have no `user.email` set, and
// git refuses to commit without one.
const COMMIT_NAME = process.env.GIT_USER_NAME ?? "Joestar";
const COMMIT_EMAIL =
  process.env.GIT_USER_EMAIL ?? "joestar@users.noreply.github.com";

/**
 * What every git step below needs in its environment.
 *
 * The token is passed per command rather than at `Sandbox.create`, for the same
 * reason `lib/claude-sandbox.js` passes the OAuth token that way: e2b's
 * create-time envs live on the client-side object and never reach the processes
 * `commands.run` spawns, so a create-time credential arrives empty.
 *
 * This is the token the credential helper resolves at git time. It is a GitHub
 * App installation token minted in the Vercel function for this one Slack
 * message and dead within the hour — the App's private key never enters the
 * sandbox at all, which is the distinction `lib/github.js` exists to preserve.
 */
function gitEnv(githubToken) {
  return { GH_TOKEN: githubToken, HISTFILE: "/dev/null" };
}

/**
 * Shares one deadline across every git step in a call. `remaining()` going
 * non-positive is what turns the next step into a synthetic failure instead of
 * a command that starts with no time left to finish.
 */
function budget(totalMs) {
  const deadline = Date.now() + totalMs;
  return { remaining: () => deadline - Date.now() };
}

/**
 * Runs one git step. Never throws: e2b raises `CommandExitError` on a non-zero
 * exit, and every caller here wants the exit code as data.
 *
 * The synthetic `{ exitCode: -1 }` for an exhausted budget is deliberate — it
 * reaches the same `switch` as a real failure, so there is no separate path
 * that could forget to disable memory.
 */
async function step(sandbox, command, { clock, envs = {} }) {
  const remaining = clock.remaining();
  if (remaining <= 0) {
    return { exitCode: -1, stderr: "memory sync ran out of its time budget" };
  }

  try {
    const res = await sandbox.commands.run(command, {
      envs,
      timeoutMs: remaining,
      requestTimeoutMs: 0,
    });
    return { exitCode: 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  } catch (err) {
    return {
      exitCode: typeof err.exitCode === "number" ? err.exitCode : -1,
      stdout: err.stdout ?? "",
      stderr: (err.stderr || err.message || "").trim(),
    };
  }
}

/**
 * The path segment for a channel's silo.
 *
 * Keyed by channel ID, not channel name: names drift, IDs don't. Stripping is
 * not paranoia about Slack — it is about what a leftover `/` or `..` would do to
 * the path we then hand to `autoMemoryDirectory`. `null` means "no usable
 * segment", and the caller disables memory rather than letting the path collapse
 * to the store root, which would aim auto memory at every channel at once.
 */
function channelDirName(channelId) {
  const cleaned = String(channelId ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!cleaned) return null;
  if (cleaned === SHARED_DIR_NAME) return null;
  return cleaned;
}

/**
 * Resolves what memory should do for this run, before anything touches a
 * sandbox. Returns a config whose `enabled: false` cases each carry a `reason`,
 * because the three of them point at completely different mistakes: an unset
 * variable is the feature being off on purpose, a missing GitHub token is a
 * degraded run, and an unusable channel ID is a bug.
 *
 * `isPrivate` decides the tier, and it defaults to private at every call site
 * that couldn't determine it. Guessing "public" would write a private channel's
 * notes into a directory every other channel reads; guessing "private" only
 * costs a silo that is more isolated than it needed to be.
 *
 * @returns {{enabled: boolean, reason?: string, tier?: 'public'|'private',
 *            dir?: string, sharedDir?: string, scope?: string, channel?: string}}
 */
export function memoryConfig({ channelId, isPrivate, hasGithubToken }) {
  if (!REPO_SLUG) {
    return { enabled: false, reason: "AGENT_MEMORY_REPO is not set" };
  }

  // The store is a private repo reached over HTTPS, and the only credential this
  // sandbox ever holds is the per-request GitHub App installation token. No
  // token, no store — and saying so beats writing notes nothing can push.
  if (!hasGithubToken) {
    return {
      enabled: false,
      reason: "no GitHub token this run, so the store cannot be authenticated",
    };
  }

  const channel = channelDirName(channelId);
  if (!channel) {
    return {
      enabled: false,
      reason: `channel id ${JSON.stringify(channelId)} yields no usable directory name`,
    };
  }

  const dir = `${STORE_DIR}/${channel}`;
  return {
    enabled: true,
    channel,
    tier: isPrivate ? "private" : "public",
    dir,
    sharedDir: `${STORE_DIR}/${SHARED_DIR_NAME}`,
    // What `git add` is allowed to stage at the end of the run. A private
    // channel is restricted to its own silo, which turns the read-only promise
    // made in the system prompt into something git enforces rather than
    // something the model is trusted to honour.
    scope: isPrivate ? channel : ".",
  };
}

/**
 * Clones (or re-points) the store and pulls it, before the agent process spawns.
 *
 * Runs on every turn, but only pays for the clone once: the box is resumed with
 * the store still on disk, so from a thread's second message on PROVISION_SCRIPT
 * takes its re-point path and what this actually costs is the pull. That split
 * is why the caller does NOT wrap it in `isNew` — the pull genuinely has to run
 * every turn (another thread in this channel may have pushed since), and a
 * thread whose first message arrived without a GitHub token has a box that never
 * provisioned at all, which an `isNew` gate would strand for the life of the
 * thread.
 *
 * The pull has to happen here and not later: Claude Code reads `MEMORY.md` when
 * the process starts, so a pull that lands afterwards updates a file nothing
 * will read again this run.
 *
 * @returns {Promise<{enabled: boolean, reason?: string, ...}>} the config to
 *          hand to `settingsPatch` and `pushMemory` — with `enabled` flipped to
 *          false if provisioning failed for any reason.
 */
export async function setUpMemory(sandbox, config, { githubToken }) {
  if (!config.enabled) {
    console.log(`memory disabled: ${config.reason}`);
    return config;
  }

  const clock = budget(SYNC_BUDGET_MS);
  const envs = {
    ...gitEnv(githubToken),
    JOESTAR_MEMORY_STORE: STORE_DIR,
    JOESTAR_MEMORY_URL: `https://github.com/${REPO_SLUG}`,
    JOESTAR_MEMORY_DIR: config.dir,
    JOESTAR_MEMORY_SHARED: config.sharedDir,
  };

  const provision = await step(sandbox, PROVISION_SCRIPT, { clock, envs });
  if (provision.exitCode !== 0) {
    const reason = `store could not be provisioned (exit ${provision.exitCode}: ${provision.stderr || "no detail"})`;
    console.error(`memory disabled: ${reason}`);
    return { enabled: false, reason };
  }
  console.log(`memory store ready at ${config.dir} (${config.tier} tier)`);

  // A pull that fails is NOT a reason to disable memory, and this is the one
  // deliberate departure from "any failure disables it". Reads go stale, but
  // writes still land and the push below rebases before it retries, so the turn
  // is degraded rather than broken. Disabling here would trade a small problem
  // for the exact silent failure the rest of this file exists to prevent.
  const pull = await step(sandbox, PULL_SCRIPT, { clock, envs });
  if (pull.exitCode === 0) console.log("memory pull ok");
  else console.warn(`memory pull failed (exit ${pull.exitCode}) — reads may be stale: ${pull.stderr || "no detail"}`);

  return config;
}

/**
 * Commits and pushes whatever the agent wrote. Call this at the single exit
 * point every path funnels through — success, error, timeout — and before the
 * sandbox is PAUSED, or the push races the box going to sleep underneath it.
 *
 * A failed push is no longer the end of that memory. The commit stays in the
 * thread's own clone, the box survives the reply, and the next turn's
 * `pull --rebase` carries it forward — it is lost only if the thread never
 * speaks again. Worth knowing before making this path any more aggressive than
 * it is: within a thread, it self-heals.
 *
 * Logs exactly one of three lines, and the distinction is the point: `push ok`,
 * `push skip [nothing changed]` and `push failed` point at three completely
 * different bugs, and collapsing them into "memory sync done" makes the most
 * common failure (the agent never wrote anything) indistinguishable from the
 * most serious one (it wrote and we lost it).
 */
export async function pushMemory(sandbox, config, { githubToken }) {
  if (!config.enabled) return;

  const clock = budget(SYNC_BUDGET_MS);
  const result = await step(sandbox, PUSH_SCRIPT, {
    clock,
    envs: {
      ...gitEnv(githubToken),
      JOESTAR_MEMORY_STORE: STORE_DIR,
      JOESTAR_MEMORY_SCOPE: config.scope,
      JOESTAR_MEMORY_SHARED_NAME: SHARED_DIR_NAME,
      JOESTAR_MEMORY_TIER: config.tier,
      JOESTAR_COMMIT_NAME: COMMIT_NAME,
      JOESTAR_COMMIT_EMAIL: COMMIT_EMAIL,
      JOESTAR_COMMIT_MESSAGE: `memory: ${config.channel}`,
    },
  });

  // Anything the script wanted a human to see, rather than an exit code.
  const notes = (result.stdout || "").trim();
  if (notes) for (const line of notes.split("\n")) console.log(`memory: ${line}`);

  switch (result.exitCode) {
    case 0:
      console.log("memory push ok");
      return;
    case EXIT_NOTHING_CHANGED:
      console.log("memory push skip [nothing changed]");
      return;
    case EXIT_CONFLICTED:
      console.error(
        "memory push failed [conflicted tree] — refused to stage a half-merged store; nothing was committed",
      );
      return;
    default:
      console.error(
        `memory push failed (exit ${result.exitCode}): ${result.stderr || "no detail"}`,
      );
  }
}

/**
 * The disposition, not a skill.
 *
 * A skill is the wrong shape for this: it only loads once the model has already
 * decided memory is relevant, and that decision is exactly what isn't happening.
 * Auto memory is tuned to be sparse — it explicitly doesn't save something every
 * session — so with no prompting at all it writes almost nothing. This lives in
 * `--append-system-prompt` because it has to be true before the model has any
 * reason to look for it.
 *
 * Kept short on purpose. Long entries crowd the index out, and editing
 * `MEMORY.md` invalidates the prompt cache from that point on, so each write has
 * a real token cost that the model should be aware it is paying.
 *
 * (Curation — merging duplicates, dropping stale entries, keeping the index
 * under its limits — genuinely is a skill, because it is user-invoked and runs
 * once. It is deliberately not built yet: prune before write works and you are
 * tidying an empty room.)
 */
export function memorySystemPrompt(config) {
  if (!config.enabled) return null;

  const shared =
    config.tier === "public"
      ? `A shared workspace memory sits at ${config.sharedDir}/, indexed by ${config.sharedDir}/MEMORY.md. Read it when this channel's own notes don't answer something, and write there instead of here when a fact holds for the whole workspace rather than just this channel.`
      : `A shared workspace memory sits at ${config.sharedDir}/, indexed by ${config.sharedDir}/MEMORY.md. Read it freely, but never write to it: this is a private channel, and nothing said here belongs in a tier every other channel reads.`;

  return [
    `You have long-term memory for this Slack channel, at ${config.dir}/. It outlives this thread and this sandbox, and it is the only thing that does.`,
    "Save what stays true: gotchas about a repo, decisions and the reasoning behind them, standing preferences, how this channel wants things done. Don't save what dies with this thread — the current task's state, transcript detail, or anything you could simply read again. It is a curated note, not a log.",
    "Keep entries to a line or two. Long ones crowd out everything else, and every edit to the index costs tokens on every later turn.",
    'When the user says "remember for this channel: …", write it down. When they ask "what do you remember about this channel?", answer from these notes. When they correct you, record the correction — that is the most valuable thing you will ever save.',
    shared,
  ].join(" ");
}

/**
 * The patch to merge into `~/.claude/settings.json`.
 *
 * User scope, not project scope, and that is load-bearing: a project-scoped
 * `autoMemoryDirectory` is only honoured after a workspace-trust prompt, which a
 * headless sandbox can never answer.
 *
 * The `false` branch is the single most important thing in this feature. The CLI
 * default is ON, so "disabled" has to be written, not merely not-written.
 * `autoMemoryDirectory: undefined` is how the merge script is told to delete the
 * key — leaving a stale one behind would point a disabled feature at a directory
 * that no longer means anything.
 */
export function settingsPatch(config) {
  if (!config.enabled) {
    return { autoMemoryEnabled: false, autoMemoryDirectory: undefined };
  }
  return { autoMemoryEnabled: true, autoMemoryDirectory: config.dir };
}

/** Exit codes the push script uses to say what happened. */
const EXIT_NOTHING_CHANGED = 30;
const EXIT_CONFLICTED = 31;

/**
 * Clone or re-point the store, then make sure both tiers' directories exist.
 *
 * Three details here are each a bug that has already happened somewhere:
 *
 * - `remote set-url` runs unconditionally, even when the clone was skipped.
 *   Otherwise changing AGENT_MEMORY_REPO never reaches a box that was cloned
 *   from the old value. That used to be a theoretical tidiness; now that a
 *   thread's box is reused for days, the skipped-clone branch is the ORDINARY
 *   path and this line is the only thing that repoints a long-lived store.
 * - A path that exists but is not a repo is moved aside, never deleted. If it
 *   holds an un-pushed commit, that commit still exists; `rm -rf` is how the
 *   self-healing story becomes a data-loss story.
 * - No `sudo`, and no `--user root`. e2b runs commands as `user`, and a store
 *   owned by root is one where every single push fails.
 *
 * The credential helper is pinned to this repo's URL rather than to github.com,
 * and it resolves `$GH_TOKEN` at git time. What lands in the config file is the
 * literal string, so the token is in no file, no URL and no argv — which matters
 * because the alternative sits in `.git/config` for the rest of a run that
 * executes model-authored code.
 */
const PROVISION_SCRIPT = `
set -u
STORE="$JOESTAR_MEMORY_STORE"
URL="$JOESTAR_MEMORY_URL"

git config --global "credential.$URL.helper" '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' || exit 11

if [ -e "$STORE" ] && [ ! -d "$STORE/.git" ]; then
  mv "$STORE" "$STORE.broken.$$" || exit 12
fi

if [ -d "$STORE/.git" ]; then
  git -C "$STORE" remote set-url origin "$URL" || git -C "$STORE" remote add origin "$URL" || exit 13
else
  mkdir -p "$(dirname "$STORE")" || exit 14
  git clone --quiet "$URL" "$STORE" || exit 15
fi

mkdir -p "$JOESTAR_MEMORY_DIR" "$JOESTAR_MEMORY_SHARED" || exit 16
`;

/**
 * Fresh clones are already current, so this is a no-op on a thread's first
 * message and the point of the exercise on every message after it: the box is
 * resumed, the clone above is skipped, and this is what stops the agent reading
 * an index that another thread has since moved on from.
 */
const PULL_SCRIPT = `
set -u
git -C "$JOESTAR_MEMORY_STORE" pull --rebase --autostash --quiet
`;

/**
 * Stage, commit, push.
 *
 * `add -A`, never `commit -a`: a brand-new memory file is untracked, and a new
 * file is the overwhelmingly common case here — `commit -a` would quietly commit
 * nothing on exactly the runs that mattered.
 *
 * The conflict check earns its place. Without it, an interrupted rebase leaves
 * `<<<<<<< HEAD` in a memory file, `add -A` stages it, the push succeeds, and
 * every future thread in this channel loads the conflict markers as fact. There
 * is no error anywhere in that sequence. Refusing to commit is strictly better
 * than committing something wrong, since the alternative costs one turn's notes
 * and the wrong version poisons the channel indefinitely.
 *
 * A rejected push means a concurrent thread pushed first, which is ordinary
 * here — two people can @mention the bot in one channel at the same time. Rebase
 * once and retry once. `.gitattributes` sets `*.md merge=union` in the store, so
 * that rebase combines both threads' notes rather than conflicting.
 */
const PUSH_SCRIPT = `
set -u
cd "$JOESTAR_MEMORY_STORE" || exit 21

if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then exit ${EXIT_CONFLICTED}; fi
if git status --porcelain | grep -qE '^(DD|AU|UD|UA|DU|AA|UU)'; then exit ${EXIT_CONFLICTED}; fi

# A private channel stages only its own silo. Anything it wrote to the shared
# tier is left behind with the sandbox — say so, because a silent drop looks
# exactly like a memory that was never written.
if [ "$JOESTAR_MEMORY_TIER" = "private" ]; then
  if [ -n "$(git status --porcelain -- "$JOESTAR_MEMORY_SHARED_NAME")" ]; then
    echo "private channel wrote to the shared tier; discarding those changes"
  fi
fi

git add -A -- "$JOESTAR_MEMORY_SCOPE" || exit 22
if git diff --cached --quiet; then exit ${EXIT_NOTHING_CHANGED}; fi

git -c user.name="$JOESTAR_COMMIT_NAME" -c user.email="$JOESTAR_COMMIT_EMAIL" \
  commit --quiet -m "$JOESTAR_COMMIT_MESSAGE" || exit 23

if git push --quiet origin HEAD:main 2>/dev/null; then exit 0; fi

echo "push rejected; rebasing onto the concurrent write and retrying once"
git pull --rebase --autostash --quiet || exit 24
git push --quiet origin HEAD:main || exit 25
`;
