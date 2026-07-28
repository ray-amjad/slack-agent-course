---
name: codex
description: Get an independent, cross-model second opinion from OpenAI's Codex CLI — a code review of a diff with a PASS/FAIL gate, an adversarial "find how this breaks" pass, or an open-ended consult. Use whenever the user asks for a "codex review", a "second opinion", to "have codex check this", to "challenge this code", or to "ask codex", or whenever you want a non-Claude read on a diff or a plan. You have LIVE access; do not say you can't.
---

# Codex — a second opinion from a different model

**You have live, authenticated access to the OpenAI Codex CLI as the `codex` command.** It is
installed in this sandbox image and its credentials are already on disk (`~/.codex/auth.json`,
written once when this thread's sandbox was created, from the `CODEX_AUTH_JSON` env var). You do **not** need to install anything, run
`codex login`, or ask the user for a key. If you are about to type "Codex isn't set up here" — stop,
it is.

Codex is terse, technically precise, and challenges assumptions. Its value is that it is **not you**:
relay what it finds faithfully rather than quietly overwriting it with your own conclusion, and add
your agreement or disagreement *after*.

## The three modes

- **Review** — an independent review of a diff, with a PASS/FAIL gate.
- **Challenge** — adversarial: "find every way this breaks in production."
- **Consult** — ask it anything about the code in front of you.

If you have already reasoned about the change yourself, Codex is the tie-breaker and blind-spot
finder — not a rubber stamp.

## Your time budget — read this before you start

The sandbox persists across the thread, but the *turn* does not: `CLAUDE_TIMEOUT_MS` caps this one
message's run at **10 minutes** (the Vercel function itself allows 800s), and that budget covers
*everything* — getting the repo on disk, your own reasoning, the codex call, and the reply that
finally reaches the thread. A run that
hits the cap is killed — the user gets an error, not a partial answer — so a review that eats the
whole turn is worse than no review at all.

Concretely:

- **Give one codex call at most 4 minutes** (`timeout: 240000` on the Bash call). Your Bash tool
  defaults to 2 minutes, which will cut a real review off mid-thought, so pass the timeout
  explicitly — but do not pass a bigger one hoping for a deeper answer.
- **One codex call per turn is the normal case.** Two is the absolute ceiling, and only if the first
  came back in well under a minute.
- **Prefer a single-commit review** (`codex review --commit "$(git rev-parse HEAD)"`) over a broad
  multi-commit `--base` review. It is faster, immune to a stale base, and it is what keeps a review
  from consuming the turn and leaving the thread with nothing.
- If a clone plus a review clearly won't fit — a huge repo, a 40-commit branch — say so and review
  the narrowest thing that matters, rather than starting something that will be killed at minute ten.

## How to run it

Run `codex` directly with your Bash tool and read its stdout. No background jobs — and the reason
is worse than it used to be. The box is **paused**, not destroyed, when the turn ends: a codex call
still running gets frozen mid-flight and thaws on some later message in this thread, with nothing
reading its stdout and no way to reach the reply. Wait for it in the foreground, or don't start it.

`~/.codex/config.toml` is seeded at provision with **`high` reasoning**, `approval_policy = "never"`
and `sandbox_mode = "danger-full-access"` — globally, for every invocation. So:

- Do **not** pass `-s` or `--dangerously-bypass-approvals-and-sandbox`, and do not restate
  `-c model_reasoning_effort` just to repeat the default. (Full access is safe here for the same
  reason `claude` runs with `--dangerously-skip-permissions`: the E2B microVM is the isolation
  boundary, not the CLI's own sandbox.)
- The one override worth using: `-c model_reasoning_effort="xhigh"` on a genuinely large or subtle
  change — and only if you have the minutes for it.

Rules that are not optional, each one a real failure that has bitten this before:

- **Always end the command with `< /dev/null`.** Codex slurps stdin when it isn't a TTY ("Reading
  additional input from stdin…") and will sit there waiting for EOF until your timeout kills it.
- **Run it from inside a git repo.** Outside one, codex refuses *but still exits 0* — so check the
  output, not the exit code. This sandbox has no repo checked out by default; `cd` into the one you
  cloned.
- Never `--json` (it buffers and hangs). Never `--enable web_search_cached` (removed — silent exit).

### 1. Resolve the base branch first (review/challenge of a diff)

```bash
BASE=$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null \
       || gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null \
       || echo main)
git fetch origin "$BASE" --quiet 2>/dev/null || true   # a stale origin/$BASE reviews merged commits too
```

### 2. Review mode

**`codex review` cannot take a prompt together with `--base`/`--commit`** — the CLI errors out
(`the argument '[PROMPT]' cannot be used with '--commit <SHA>'`). Run it **promptless**; its built-in
review mandate already hunts real defects. Anything with a custom focus goes through challenge mode
instead, which is the prompt-carrying path.

```bash
# The default: one commit, fast, immune to a stale base.
codex review --commit "$(git rev-parse HEAD)" < /dev/null

# Several commits that only make sense together — costs more of the turn:
codex review --base "$BASE" < /dev/null
```

**Verdict rule:** any `[P1]` finding → **FAIL**. Only `[P2]`s, or nothing → **PASS**.

### 3. Challenge mode (adversarial — and the home for any custom focus)

```bash
codex exec "Review the changes on this branch (run \`git diff origin/$BASE\`). Your job is to find how
   this fails in production: edge cases, race conditions, security holes, resource leaks, silent data
   corruption. Be adversarial and thorough. No compliments — just the problems." < /dev/null
```

Fold a user-requested focus ("check the auth paths") into that prompt.

### 4. Consult mode

```bash
codex exec "<the user's question about the code>" < /dev/null
```

## Reporting back — you are answering in Slack, not a terminal

There is exactly **one** message at the end of this turn: your final reply, which the function edits
into the `🧠 Thinking…` placeholder in the thread. You cannot post progress messages, and the only
other channel you have is `/tmp/outputs/` — anything you write there is uploaded to the thread after
you finish. (The placeholder does tick with the name of your current tool call every few seconds, so
a long `codex review` reads as activity rather than a hang. That is the only "still working" signal
there is; don't try to manufacture another.)

So:

- **Never dump raw codex logs.** Trim its token counts, session ids, and progress spam.
- **Lead with the verdict**: `Codex review: *FAIL* — 2 × P1, 1 × P2` (or `*PASS*`).
- Then **one line per finding**: `file:line` + the one-line problem, in **Codex's own wording**. Don't
  paraphrase its findings into your voice; that is the whole point of asking a different model.
- Then a short **"My read:"** — where you agree, and where you think Codex is wrong and why. **Never
  silently drop a P1 you disagree with.** Report it, then say you disagree and why.
- If the findings are long, put the full codex output in `/tmp/outputs/codex-review.md` and keep the
  reply to the verdict, the findings, and your read.

## Failure modes

- **Silent exit** — codex exits 0, echoes your prompt back, and produces no response block. Retry
  **once** after ~10 seconds. If it happens twice, report it as a transient codex issue. Do not
  invent a verdict from an empty run.
- **Auth failure** — if codex reports an authentication error, **do not work around it**: no
  `codex login`, no API key, no substitute. Expect this to get likelier the older the thread is:
  `~/.codex/auth.json` was written into this box when the thread's sandbox was created and is never
  refreshed afterwards, while the ChatGPT token inside it lasts about ten days. Tell the user the
  `CODEX_AUTH_JSON` secret is missing or stale and needs re-pasting from a fresh local
  `~/.codex/auth.json` — and that a re-paste only reaches sandboxes created after it, so **this**
  thread needs starting again to pick it up.
- **Missing binary** — if `codex` isn't found at all, this box was created from a template that
  predates it, and the fix is `npm run template:build`. Same caveat: rebuilding the template does
  not re-image a box that already exists, so it lands on new threads, not this one. Say that; don't
  try to `npm i -g @openai/codex` mid-turn.

In every one of these cases, answer the user with what you *do* have plus a plain statement that the
second opinion was unavailable. A missing second opinion is a stated degradation, never a silent one.

## One last thing

Codex runs with full access here, so it **can** write files. Its jobs are review, challenge and
consult only — anything that *changes* the repo is yours. If a codex run unexpectedly modified
something, `git status` and say so.
