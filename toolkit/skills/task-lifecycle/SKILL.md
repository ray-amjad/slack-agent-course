---
name: task-lifecycle
description: The default path for shipping any real task — a feature, a non-trivial fix, or a "make a change" ask — end-to-end in a repo, as a reviewed, verified PR, not just a diff. This is not an optional add-on: use it whenever the user asks you to implement, build, add, fix, or ship anything in one of their repos, whether or not they say "PR" or "review" out loud — if the change is going into a repo and is more than a one-line edit, this is the flow. Also use it any time they want the change reviewed, tested, or verified before they look at it. Runs the full loop: explore the codebase (parallel read-only subagents) → build (fresh subagent) → open a PR → adversarial review three ways in parallel (Claude + Codex for defects, thermo-nuclear for structure, all fresh subagents) → fix (another fresh subagent, up to two rounds) → verify the flow actually works against a real DB and browser (fixing once and re-verifying if the running flow breaks) → report back with progress along the way, flagging any still-open plausible-but-unconfirmed findings at the end → confirm with the user before anything merges.
---

# Task lifecycle: build, review, fix, verify, ship

You are the orchestrator, and you keep your own hands off the code. Every hands-on step — **build**,
**review**, **fix**, **verify** — runs in its own fresh subagent. Your job is to sequence them, carry
the diff/findings between them, report progress to Slack, and finally **stop and ask the user** — you
never merge on your own.

The shape:

```
explore (parallel subagents) → build (subagent) → open PR → [review (Claude + Codex + thermo-nuclear) → fix] ×1–2 → [verify (subagent) → fix] ×1 → confirm
        │                           │               │                                                              │                              │
   a map, not a diff            git branch      slack-post                                              slack-upload GIF                  final reply
```

## Why every role is its own subagent (this is the whole point)

- **Explore** runs as a **fan-out of read-only subagents**, because finding *where* a change goes is a
  different job from making it, and it parallelises perfectly. Each one sweeps a different angle and
  returns file paths and patterns — not file dumps — so the orchestrator ends up holding a map of the
  codebase instead of the codebase.
- **Build** runs in a subagent so the orchestrator stays a clean coordinator. A real feature build is
  a lot of context — file reads, edits, test runs — and keeping it off the main thread means your
  orchestration logic doesn't get buried under it. The builder returns just a summary and the branch.
- **Review** runs in **fresh subagents that see only the diff**, prompted to try to break the change.
  A reviewer that also wrote the code rationalises its own choices; one with no memory of your intent
  is honest by construction. There are **three** of them, on purpose, and they run **in parallel** —
  two hunting defects (Claude, Codex) and one hunting structure (thermo-nuclear), because "is it
  correct?" and "is it well-built?" are questions that a single reviewer trades off against each
  other and neither of which the builder can ask about its own work.
- **Fix** runs in **another fresh subagent** given only the findings, so it repairs what the review
  actually found rather than defending what you meant.
- **Verify** runs in its own subagent too (the verify skill says so) — booting a server and driving a
  browser is noisy, and isolating it keeps the run clean.

You stay on the main thread the whole time: dispatch, carry results between agents, `slack-post`,
decide when to stop.

## 0. First, check if you're resuming

A full run is long, and it can stop partway — a timeout, the Stop button, an error, a lost
connection. When a follow-up says "continue" (or you otherwise wake into a thread that was already
mid-build), **do not start over.** Re-cloning and rebuilding on top of an existing branch duplicates
work and corrupts the diff. Percy keeps no database, but the run's progress is already recorded in
durable places — read them first:

- **The thread's own milestones.** You `slack-post` at every phase (see below), so the thread is your
  progress log. `slack-read "$SLACK_CHANNEL" "$SLACK_THREAD_TS"` and read your past posts — the last
  one tells you the furthest phase you reached.
- **Git + the PR, which are the source of truth.** `cd /home/user/work/<repo>` and check:
  - branch exists with commits (`git log --oneline`) → **build is done**, skip steps 1 and 2;
  - `gh pr list --head <branch> --json number,url` returns a PR → **step 3 is done**, capture its number;
  - `gh pr view <n> --comments` → each review you posted is a comment; **N review comments = N rounds
    done**, resume at round N+1 (or go to verify if you already hit the 2-round cap);
  - a verification message/GIF already in the thread → **jump to step 6 (confirm)**.

Reconcile the two (the PR wins if they disagree — a milestone can post before a phase fully lands),
then `slack-post "Resuming — picking up at <phase>."` so the user knows you continued rather than
restarted, and go straight to that phase. Only fall through to step 1 if nothing exists yet.

Note that **explore (step 1) is never worth resuming into.** If a branch already has commits, the
exploring is embodied in them; re-running it would only re-derive a map for work that's already done.

## 1. Explore — find what to change, before anything changes it

Get the code on disk first, because everything below needs it — but **look before you clone**. Your
sandbox belongs to this thread and is resumed between messages, so on a follow-up the repo is
already sitting at `/home/user/work/<repo>` with your branch and commits on it: `cd` in and carry
on. Clone only when it isn't there (`clone-repo <name>`, then `cd` in — see the **github** skill).
Then, **before** you brief a builder, find out where the change actually goes. A builder that starts by guessing at file locations spends its context reading the wrong files
and then writes code in the wrong shape — and by the time that shows up, it shows up as review
findings the fixer has to unpick.

Dispatch **3–5 read-only explorer subagents in a single message** (the Task tool, `background: false`,
the **Explore** agent type where it exists — otherwise a plain subagent told explicitly *do not edit
any files*). They're independent, so one message means they run concurrently instead of serially.

Give each one a **different angle**, not the same question five times — overlapping explorers return
the same three files and you've bought nothing:

- **The feature surface** — where does the thing being changed live today? Entry points, routes,
  handlers, components, the files a user's request actually flows through.
- **The nearest precedent** — find the *most similar existing feature* and how it's built end to end.
  This is usually the highest-value angle: it hands the builder a shape to match instead of invent.
- **Data and contracts** — the schema, models, migrations, API/tRPC procedures, and types the change
  will have to touch or conform to.
- **Tests and fixtures** — how this area is tested, where those tests live, what a new test would look
  like next to them.
- **Config, flags, and wiring** — env vars, feature flags, DI/registry files, and the "you must also
  register it here" steps that are invisible until you miss one. Worth its own explorer in an
  unfamiliar codebase; fold it into the others in a small one.

Tell every explorer the same three things: **why** you're asking (the change you're about to build —
it's what lets them filter signal from noise), that you want **paths, symbols, and patterns, not file
contents**, and that a **short report beats a thorough dump**. An explorer that returns 400 lines of
pasted source has moved the context problem rather than solved it.

Scale the fan-out to the ask: a one-file tweak in a repo Percy already knows needs one explorer or
none; a feature in an unfamiliar codebase wants all five. **Skip the phase entirely when the user
already told you the files** — a spec that names its own touch-points has done this step for you, and
re-deriving it is just latency.

Synthesise what comes back into a short brief — the files to change, the pattern to follow, the
precedent to copy, the gotchas — and hand it to the builder in the next step. **That brief is the
deliverable of this phase; the explorers' full reports are not.** Then:

```bash
slack-post "Explored the codebase — building now. Touching roughly: <files>."
```

## 2. Build it — in a builder subagent

Dispatch a subagent (the Task tool) to implement the change. It starts fresh with **no memory of the
request**, so brief it fully: the feature to build in your own words, **the exploration brief from
step 1**, and — if the user pointed you at a spec, plan, issue, or design doc (e.g. a
`plans/…/plan.md`) — the path to it, with an instruction to **read that file first and treat it as the
source of truth for scope**. Don't make the builder reverse-engineer what you already know. Then tell
it to:

- if there's a spec/plan/issue, read it first and build to it — nothing more, nothing less;
- start from the exploration brief — the named files and the precedent to match — but **verify before
  trusting it**: it's a map drawn by an agent that wasn't building, so if the code contradicts it, the
  code wins and it should say so when it reports back;
- the repo is on disk at `/home/user/work/<repo>` (step 1 either cloned it or found the clone an
  earlier turn left) — `cd` there and work on a **new branch**, never the default one, and cut that
  branch off the freshly fetched default (`git fetch origin`, then branch from `origin/<default>`)
  rather than off whatever happens to be checked out: this box outlives the task that made it, so it
  can still be sitting on a previous task's branch, and branching from there silently drags that
  task's commits into this PR;
- implement the feature matching the patterns the brief names; keep the diff focused (unrelated
  cleanup muddies the review and verification);
- commit with a clear message and **leave the branch checked out** — do NOT open a PR (that's your
  job, next);
- return a short summary: the branch name, the repo path (`/home/user/work/<repo>`), what it built,
  the files it touched, and anywhere the brief was wrong.

The subagent shares this sandbox's filesystem, so the committed branch is waiting for you on disk when
it returns.

## 3. Open the PR

`cd` into the repo path the builder returned, then:

```bash
open-pr "<title>" "<what changed and why>"
```

It pushes the branch and prints the PR URL. Immediately tell the user:

```bash
slack-post "Opened the PR: <url> — running a three-way review (Claude + Codex + thermo-nuclear) now."
```

Capture the PR number/URL; the review and fix rounds attach to it.

## 4. Review → fix, up to two rounds

Run this loop **at most twice**. Stop early the moment a review comes back clean.

### Review (three independent reviewers, in parallel, every round)

Review the **same diff** three ways — a blocking finding from **any** of them must be fixed. None has
seen your intent, so between them they catch what one alone rationalises away. Get the base once and
reuse it: `BASE=$(gh pr view <n> --json baseRefName -q .baseRefName)`.

**Dispatch all three in a single message so they run concurrently** (`background: false` on every one
— see below). They're fully independent: A and B ask *is this correct?*, C asks *is this well-built?*,
and none needs the others' output. Running them serially costs three times the wall-clock inside a
turn that has a 3-hour cap.

**Reviewer A — Claude, via the code-review skill.** Read the **code-review** skill and run it. It
carries Claude Code's own `/code-review` prompts verbatim — 8 finder angles fanned out across
subagents, then a verify pass that kills the false positives — so Percy's review is the same review
the user gets on their laptop, not an ad-hoc "look for bugs" prompt.

**Pick the tier by the size of the diff** (the skill has the table and the exact rule):

```bash
git diff --shortstat "$BASE"...HEAD
```

- **≲ 100 lines and ≲ 3 files → `medium`** — tuned for precision.
- **anything bigger, or touching auth / money / migrations / concurrency → `high`** — recall-biased
  verify, which is what you want when a miss ships.

When it's close, go `high`; the tiers cost about the same and only differ in what they miss. Say
which tier you ran when you report back.

Dispatch it as a subagent (the Task tool, **`background: false`**) with the tier's prompt verbatim as
its prompt, plus `$BASE`, the branch, and the repo path. It returns a JSON array of findings.

**`background: false` is not optional, here or in any subagent this run dispatches.** Agents default
to background since Claude Code 2.1.198 and notify the parent later; a Percy turn is one-shot and
headless, so "later" never arrives — the turn ends with an empty result and no answer in the thread.
Never end a turn waiting on a notification, and never `SendMessage` an agent to resume it in the
background. The **code-review** skill explains this at the top; it applies to every dispatch this run
makes — the explorers, the builder, all three reviewers, the fixer, and the verifier. **Parallel and
backgrounded are not the same thing:** several `background: false` calls in one message run
concurrently *and* block until they all return, which is exactly what you want for the explore fan-out
and the three reviewers.

**Reviewer B — Codex, a different model entirely.** In the repo dir, run Codex's review over the same
diff (see the **codex** skill for how to run and read it). It keeps its **own** built-in review
mandate — do not try to feed it the code-review prompt above. `codex review` **cannot take a custom
prompt with `--base`/`--commit`** at all, and its built-in mandate is tested here (it correctly
P1-flagged a planted bug, having written its own repro). Two mandates finding the same defect is
stronger evidence than one mandate run twice, so the asymmetry is a feature.

Codex has no tier to pick, either: its `high` reasoning is pinned globally in `~/.codex/config.toml`,
so unlike Reviewer A's tier it can't be forgotten. Run it alongside the Claude reviewer:

```bash
codex review --base "$BASE" < /dev/null
```

Single-commit branch? Use `--commit "$(git rev-parse HEAD)"` instead of `--base` — cleaner and immune
to a stale base. A `[P1]` in its output is a blocking finding. If Codex is unavailable in this box (no
binary, or `codex login status` fails on a stale `CODEX_AUTH_JSON`), **say so in the thread and proceed
with Reviewer A alone** — a missing second opinion is a stated degradation, never a silent drop.

**Reviewer C — thermo-nuclear, a different question entirely.** Read the
**thermo-nuclear-code-quality-review** skill and run it over the same diff, as its own subagent, in
the same message as A and B. It has no tier to pick.

C is not a third bug-hunter. A and B both ask whether the code is *correct*, and a reviewer holding
that question will wave through a change that works while quietly making the codebase worse to live
in — that's the exact failure mode of a two-defect-reviewer setup, and it compounds silently across
PRs. C only asks whether the change is *well-built*: abstraction quality, spaghetti growth, files
crossing 1000 lines, and the "code judo" move that would delete a category of complexity rather than
rearrange it. Expect its findings to look nothing like A's and B's; that's the point, and it's why
overlap between them is not the confidence signal it is between A and B.

**Merge the three.** A defect flagged by **any** reviewer is in scope for this round's fix when it's
**CONFIRMED** (Reviewer A), a **`[P1]`** (Codex), or a **presumptive blocker** (Reviewer C's approval
bar) — send those to the fixer now. Everything softer is carried, not fixed:

- A **PLAUSIBLE** finding from the code-review skill (mechanism real, trigger uncertain) is not
  fix-loop material by itself — don't send a fixer chasing a maybe.
- An **advisory** finding from Reviewer C (`blocking: false`) is a suggestion, not a defect.
- A Reviewer C blocker **whose remedy is bigger than the PR** — "reframe the state model", "split this
  module" — does not go to the fixer either. C is ambitious on purpose, which is what makes it useful
  and also what makes it dangerous to hand straight to a fixer: the fix round would rewrite far more
  than the change under review, and the diff you verified stops being the diff you reviewed.

Carry all three kinds forward and surface them once, at the very end, in step 6's confirm message,
after the verification result is posted. Note where A and B agree (higher confidence on a defect), and
report C's findings as their own group rather than blending them into the defect count — "3 bugs" and
"3 bugs and a structural objection" are different messages to the person deciding whether to merge.
Then **post the merged set as a PR comment** and to Slack:

```bash
gh pr comment <n> --body "$(cat findings.md)"     # merged review (Claude + Codex + thermo-nuclear), on the PR
slack-post "Review round 1 — Claude (high) + Codex + thermo-nuclear: 3 defects (2 both flagged, 1 Codex-only) and 1 structural blocker. Fixing now."
```

If **all three** come back clean, `slack-post` that and skip straight to **verify** — don't fix
nothing, and don't run a second round for its own sake.

### Fix (a different fresh subagent, every round)

Dispatch a **new** subagent with only the findings and the repo. Tell it to fix exactly those
findings, commit, and push (the PR updates itself — no new PR). It should not wander into unrelated
refactors. When it's done:

```bash
slack-post "Fixed round 1, PR updated. Re-reviewing."
```

Then loop: review the updated diff again (round 2). After round 2, **stop even if findings remain** —
report the leftovers honestly in the final message rather than looping forever. Two rounds is the cap
on purpose: it catches the bugs that matter without burning the turn on diminishing returns.

## 5. Verify it actually works

Now prove the feature actually runs — end to end, against a real DB — using the **verify** skill (read
it; it has the db-fresh boot loop). Run it in its own subagent, and **look at what is already running
before you boot anything**: this box is paused rather than destroyed between turns and the pause
snapshots memory, so last turn's dev server is still holding its port and a second one simply fails to
bind — the "I couldn't boot the app" you were about to report would be your own leftover. Reuse it or
kill it. Note too that `db-fresh` wipes whatever an earlier turn put in that database. **Match the
proof to what you built:**

- **A user-facing flow** → drive it in a headless browser and capture a **GIF** (screenshot per
  action → animated GIF; Slack renders GIF inline, not `.webm`), sent with
  `slack-upload flow.gif --comment "…"`.
- **A backend/API change with no UI** → exercise the real endpoint (`curl` the route, or call the tRPC
  procedure) and show the request and the response. A browser GIF proves nothing here — don't fake one.
- **Either way**, add an **independent DB confirmation** that the data actually landed
  (`psql "$DATABASE_URL" -c "select …"`), not just that a handler returned 200.

The verify subagent reports back **which of three outcomes** it hit, and you route on that:

- **Passed** → go to confirm.
- **The flow ran and did the wrong thing** — a real error, wrong output, a 200 with no DB row — is a
  defect the three diff-only reviewers can't catch, because they read the change, they don't run it.
  `slack-post` it, then dispatch **one** fresh **fix** subagent given *only the verify evidence* (the
  failing step, the console/stack trace, the empty `select`), have it commit + push (the PR
  self-updates), and **re-verify once**. If it still fails, stop — report the failure honestly rather
  than loop. **One round is the cap**, on purpose: each verify cycle boots a server and drives a
  browser (minutes), so a second round risks the turn cap for diminishing returns — the same
  discipline as the two-round review cap.
- **You could not boot the app or reach the flow** (missing env, `db-fresh` failed) → **do not
  fix-loop** — no app-code change repairs a missing credential. **Say so plainly** — a claimed pass
  you didn't get is worse than an honest "couldn't verify, here's why" (the verify skill is explicit
  about this) — and go to confirm.

## 6. Confirm — do not merge

Your final reply is the wrap-up and a genuine question. Include:

- the PR link;
- what you built, in a sentence or two;
- the review rounds: how many findings, what you fixed, anything left unaddressed;
- the verification result (the GIF is already in the thread; state whether it passed and what the DB
  confirmed) — and if verify caught a runtime failure you then fixed, say so, the same as a
  review-driven fix;
- **after** the verification result, everything carried forward from review that was never fixed or
  refuted, in two short groups — call these out once, here, rather than mixing them into the
  fixed-findings count or letting them quietly disappear:
  - **PLAUSIBLE** findings (Reviewer A) — e.g. "Also flagged — plausible, unconfirmed: `file:line` —
    <failure_scenario>." Open questions, not settled bugs.
  - **Structural notes** (Reviewer C) — its advisory findings, and any blocker whose remedy was too
    big for this PR, with the remedy it proposed: "Thermo-nuclear also flagged: `file:line` —
    <summary>; it wants <remedy>, which is bigger than this change." That last one is a real
    suggestion the user may want to take as a follow-up PR, so name it as such;
- then ask: **"Want me to merge this, or change anything first?"**

Stop there. Merging is the user's call — they answer in the thread and the next turn picks it up. Do
not run `gh pr merge` unless they say yes.

## Keep the thread alive

A turn that runs for minutes with no output looks like a hang. `slack-post` a line at each milestone
(explored, PR opened, each review, each fix, verifying, done). These are durable messages; the auto "🧪 working…"
ticker is not a substitute. Don't narrate every command — just the milestones above.

These posts do double duty: they're also the **resume log** (step 0). Because each one names the phase
it just finished, a run that dies and is told to "continue" can read them back and know exactly where
to pick up. That only works if you actually post one per phase — so don't skip them.
