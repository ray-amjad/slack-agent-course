/**
 * The one in-sandbox guardrail: a PreToolUse hook that refuses destructive
 * `git push` refspecs.
 *
 * WHAT IT IS FOR. The App's branch ruleset protects the default branch only, so
 * `contents: write` can still force-push over — or delete — every other branch in
 * the installed repos. That is the single destructive thing GitHub is willing to
 * let this token do, so it's the single thing worth catching here.
 *
 * WHAT IT IS NOT. It is a string match, and it prevents an agent's bad decision,
 * not an attacker's. `git push` reached through an alias, a shell function, or
 * indirection (`G=push; git $G --force`), or `git-receive-pack` invoked directly,
 * all walk straight past it. Anyone who can @mention the bot can run arbitrary
 * code in this sandbox, so treat this as a nudge and let GitHub be the boundary.
 * There is deliberately no general dangerous-command denylist: the sandbox is
 * disposable — one thread's box, and losing it costs that thread its memory and
 * nothing else — and a list that stops the obvious cases while missing the rest
 * reads as protection it isn't.
 *
 * It also errs loud: `echo "git push --force" > notes.txt` trips it, because the
 * matcher reads the command as text and doesn't know that one is a quoted
 * string. Blocking a mention of the thing is the cheap side of that trade.
 *
 * The script is a string rather than a file on disk so Vercel's bundler has
 * nothing to leave behind, and it's Node rather than bash because the image has
 * no `jq` and the hook payload arrives as JSON on stdin.
 */

export const CLAUDE_DIR = "/home/user/.claude";
export const HOOK_PATH = `${CLAUDE_DIR}/hooks/block-destructive-push.js`;

/**
 * The `hooks` key, as a patch to merge into settings.json rather than the whole
 * file — see lib/sandbox-settings.js, which now owns that write because memory
 * needs to configure the same file on every run.
 *
 * It is only ever merged in alongside the hook script itself, and on a box that
 * survives the turn that pairing takes deliberate care: settings.json persists,
 * so a registration merged in on turn 1 is still there on turn 9 — which is why
 * `setUpGithub` writes HOOK_PATH on every token-holding turn rather than only on
 * the turn that created the box. Registering the hook without writing HOOK_PATH
 * would point every Bash call at a module that isn't there, and `node` failing
 * to load it is not a silent failure — it is every shell command in the run
 * dying at the gate.
 *
 * This file is also where a stale template's `apiKeyHelper` once overrode
 * CLAUDE_CODE_OAUTH_TOKEN and broke every run with "Invalid API key"; the merge
 * strips that key explicitly, since merging no longer overwrites it for free.
 */
export const HOOK_SETTINGS = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: `node ${HOOK_PATH}` }],
      },
    ],
  },
};

export const HOOK_SCRIPT = `#!/usr/bin/env node
// PreToolUse hook — blocks force-push and remote branch deletion.
// Claude Code sends the tool call as JSON on stdin. Exit 2 blocks the call and
// feeds stderr back to the model; exit 1 would NOT block, and exit 0 lets it run.
// See lib/sandbox-guardrails.js for what this does and does not actually stop.

// Long flags that rewrite or remove remote refs. --mirror and --prune are here
// because they delete remote branches too — same capability, quieter spelling.
const DESTRUCTIVE = new Set([
  "--force",
  "--force-with-lease",
  "--force-if-includes",
  "--delete",
  "--mirror",
  "--prune",
]);

const SEPARATORS = new Set([";", "&&", "||", "|", "&"]);

/**
 * Splitting on whitespace is not shell parsing, and isn't trying to be: it reads
 * far enough to spot the flags an agent would reach for, and anything cleverer
 * than that was never going to be caught by a string match anyway.
 */
function isDestructivePush(command) {
  const tokens = String(command || "").split(/\\s+/).filter(Boolean);
  let sawGit = false;
  let inPush = false;

  for (const token of tokens) {
    const t = token.replace(/^['"]|['"]$/g, "");

    if (SEPARATORS.has(t)) {
      sawGit = false;
      inPush = false;
      continue;
    }
    if (t === "git") {
      sawGit = true;
      continue;
    }
    if (sawGit && t === "push") {
      inPush = true;
      continue;
    }
    if (!inPush) continue;

    if (DESTRUCTIVE.has(t)) return true;
    // --force-with-lease=main:abc123 and friends
    if (t.startsWith("--force")) return true;
    // Short flags, bundled or not: -f, -d, -fu, -dq. No other push short flag
    // contains an f or a d, so this can't fire on -u/-q/-v/-n.
    if (/^-[A-Za-z]+$/.test(t) && /[fd]/.test(t.slice(1))) return true;
    // A leading + forces that refspec; a leading : pushes nothing onto the
    // remote ref, which is how you delete a branch without saying --delete.
    if (t.startsWith("+") || t.startsWith(":")) return true;
  }

  return false;
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let command = "";
  try {
    command = JSON.parse(raw)?.tool_input?.command ?? "";
  } catch {
    process.exit(0); // unparseable payload is not our call to block on
  }

  if (!isDestructivePush(command)) process.exit(0);

  process.stderr.write(
    "Force-push and branch deletion are disabled. Push a new branch and open a PR instead.\\n",
  );
  process.exit(2);
});
`;
