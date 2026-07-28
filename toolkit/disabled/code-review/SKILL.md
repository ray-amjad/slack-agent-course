---
name: code-review
description: Run a structured, multi-angle code review of a diff — finder angles fanned out across subagents, then a verify pass that kills the false positives. Use whenever you review a diff, a branch, or a PR and want more than a read-through: as Reviewer A inside the task-lifecycle loop, or any time the user asks for a code review, "review this properly", "what's wrong with this diff", or a second look before merging. Two effort tiers — medium for precision, high for recall — chosen by the size of the change.
---

# Code review — the real prompts, run verbatim

This is Claude Code's own `/code-review`, ported into Percy so a review here is the same review the
user gets on their laptop. The two prompts below are **verbatim** — they are the product's, not a
paraphrase, and they earn their length: the finder angles are the recall, and the verify pass is the
precision. Do not summarise, trim, or "improve" them. Paste the chosen tier into the subagent as its
prompt, exactly as written.

**One mapping:** the prompts say *"via the Agent tool"* — in this box that tool is called **Task**.
Same thing. Everything else runs as written.

<important if="you are dispatching any subagent from this skill">

**Every Task call here MUST pass `background: false`.** Since Claude Code 2.1.198 agents run in the
**background by default** and report back later via a `<task-notification>` — the tool's own parameter
says so: *"Agents run in the background by default… Set to false to run this agent synchronously when
you need its result before continuing."*

That default is correct for an interactive laptop session and **fatal here**. A Percy turn is
one-shot and headless: when it ends, the process exits and the sandbox pauses. There is no "later" to
be notified into. A backgrounded finder angle orphans, the turn closes with an empty result, and the
thread gets no answer. On agentstack PR #1031 a review round parked itself exactly this way — *"I'll
wait for its notification rather than poll"* — and burned the rest of the turn waiting for a message
that a headless turn can never receive.

(That run was finally ended by the turn cap, not by the backgrounding itself — the cap is
what SIGINTs a turn that overruns, and it reports ⏱, not ❌. Don't let that stop you honouring this:
a turn spent waiting on a notification is a turn spent doing nothing, and the cap is a backstop, not
a scheduler.)

So: fan the angles out **in a single message, all with `background: false`**, and let the tool calls
block until every one returns. **Never end a turn waiting on a notification, and never use
`SendMessage` to resume an agent in the background to "finish collecting" results** — that is the
exact move that killed the run. If you find yourself about to say "I'll wait for its notification
rather than poll", stop: you are about to hang the turn.

</important>

## Pick the tier by the size of the change

Measure the diff first, then pick:

```bash
git diff --shortstat "$BASE"...HEAD    # e.g. "7 files changed, 214 insertions(+), 31 deletions(-)"
```

| Diff | Tier | Why |
|---|---|---|
| ≲ 100 changed lines **and** ≲ 3 files | **medium** | 8 angles × 6 candidates, 3-state verify, ≤8 findings. Tuned for **precision** — every finding is one a maintainer would act on. |
| anything larger, or touching auth / money / data-migration / concurrency | **high** | Same 8 angles, but the verify pass is **recall-biased** — PLAUSIBLE by default, REFUTED only when you can construct the proof. ≤10 findings. |

**When it's close, go high.** The tiers cost roughly the same to run; the asymmetry is in what they
miss. Diff *size* is a weak proxy for review difficulty — a five-line change is exactly where a race
condition hides — so size only decides the easy calls, and anything touching a dangerous subsystem is
high regardless of how few lines it is.

Say which tier you ran and why when you report back. A review whose depth is invisible reads like a
rubber stamp.

---

## MEDIUM

> `medium effort → 3+5 angles × 6 candidates → 1-vote verify → ≤8 findings`
>
> You are reviewing for **precision** at medium effort: every finding you surface
> should be one a maintainer would act on.
>
> ## Phase 0 — Gather the diff
>
> Run `git diff @{upstream}...HEAD` (or `git diff main...HEAD` / `git diff HEAD~1`
> if there's no upstream) to get the unified diff under review. If there are
> uncommitted changes, or the range diff is empty, also run `git diff HEAD` and
> include the working-tree changes in scope — the review often runs before the
> commit. If a PR number, branch name, or file path was passed as an argument,
> review that target instead. Treat this diff as the review scope.
>
> ## Phase 1 — Find candidates (3 correctness angles + 3 cleanup angles + 1 altitude angle + 1 conventions angle, up to 6 each)
>
> Run **8 independent finder angles** via the Agent tool. Each
> surfaces **up to 6 candidate findings** with `file`, `line`, a one-line
> `summary`, and a concrete `failure_scenario`.
>
> ### Angle A — line-by-line diff scan
>
> Read every hunk in the diff, line by line. Then Read the enclosing function for
> each hunk — bugs in unchanged lines of a touched function are in scope (the PR
> re-exposes or fails to fix them). For every line ask: what input, state, timing,
> or platform makes this line wrong? Look for inverted/wrong conditions,
> off-by-one, null/undefined deref, missing `await`, falsy-zero checks,
> wrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.
>
> ### Angle B — removed-behavior auditor
>
> For every line the diff DELETES or replaces, name the invariant or behavior it
> enforced, then search the new code for where that invariant is re-established.
> If you can't find it, that's a candidate: a removed guard, a dropped error
> path, a narrowed validation, a deleted test that was covering a real case.
>
> ### Angle C — cross-file tracer
>
> For each function the diff changes, find its callers (Grep for the symbol) and
> check whether the change breaks any call site: a new precondition, a changed
> return shape, a new exception, a timing/ordering dependency. Also check callees:
> does a parallel change in the same PR make a call unsafe?
>
> ### Reuse
>
> The angles above hunt for bugs; this one and the next two hunt for cleanup in
> the changed code. Flag new code that re-implements something the codebase
> already has — Grep shared/utility modules and files adjacent to the change,
> and name the existing helper to call instead.
>
> ### Simplification
>
> Flag unnecessary complexity the diff adds: redundant or derivable state,
> copy-paste with slight variation, deep nesting, dead code left behind. Name
> the simpler form that does the same job.
>
> ### Efficiency
>
> Flag wasted work the diff introduces: redundant computation or repeated I/O,
> independent operations run sequentially, blocking work added to startup or
> hot paths. Also flag long-lived objects built from closures or captured
> environments — they keep the entire enclosing scope alive for the object's
> lifetime (a memory leak when that scope holds large values); prefer a
> class/struct that copies only the fields it needs. Name the cheaper
> alternative.
>
> ### Altitude
>
> Check that each change is implemented at the right depth, not as a fragile
> bandaid. Special cases layered on shared infrastructure are a sign the fix
> isn't deep enough — prefer generalizing the underlying mechanism over adding
> special cases.
>
> ### Conventions (CLAUDE.md)
>
> Find the CLAUDE.md files that govern the changed code: the user-level
> ~/.claude/CLAUDE.md, the repo-root CLAUDE.md, plus any CLAUDE.md or
> CLAUDE.local.md in a directory that is an ancestor of a changed file (a
> directory's CLAUDE.md only applies to files at or below it). Read each one
> that exists, then check the diff for clear violations of the rules they state.
> Only flag a violation when you can quote the exact rule and the exact line
> that breaks it — no style preferences, no vague "spirit of the doc"
> inferences. In the finding, name the CLAUDE.md path and quote the rule so the
> report can cite it. If no CLAUDE.md applies, return nothing for this angle.
>
> Cleanup, altitude, and conventions candidates use the same
> `file`/`line`/`summary` shape; in `failure_scenario`, state the concrete
> cost (what is duplicated, wasted, harder to maintain, or which CLAUDE.md rule
> is broken) instead of a crash. Correctness bugs always outrank cleanup,
> altitude, and conventions findings when the output cap forces a cut.
>
> Pass every candidate with a nameable failure scenario through — finders that
> silently drop half-believed candidates bypass the verify step and are the
> dominant cause of misses.
>
> ## Phase 2 — Verify (1-vote, 3-state)
>
> Dedup candidates that point at the same line/mechanism, keeping the one with
> the most concrete failure scenario. For each remaining candidate, run **one
> verifier** via the Agent tool: give it the diff, the relevant file(s), and the
> candidate, and have it return exactly one of:
>
> - **CONFIRMED** — can name the inputs/state that trigger it and the wrong
>   output or crash. Quote the line.
> - **PLAUSIBLE** — mechanism is real, trigger is uncertain (timing, env,
>   config). State what would confirm it.
> - **REFUTED** — factually wrong (code doesn't say that) or guarded elsewhere.
>   Quote the line that proves it.
>
> Keep candidates where the vote is CONFIRMED or PLAUSIBLE.
>
> ## Output
>
> Return findings as a JSON array of at most 8 objects:
>
>     "file": "path/to/file.ext",
>     "line": 123,
>     "summary": "one-sentence statement of the bug",
>     "failure_scenario": "concrete inputs/state → wrong output/crash",
>     "verdict": "CONFIRMED" | "PLAUSIBLE"
>
> Ranked most-severe first. If more than 8 survive, keep the 8 most
> severe. If nothing survives verification, return `[]`.

---

## HIGH

> `high effort → 3+5 angles × 6 candidates → 1-vote verify (recall-biased) → ≤10 findings`
>
> You are reviewing for **recall** at high effort: catch every real bug a careful
> reviewer would catch in one sitting. At this level, catching real bugs matters
> more than avoiding false positives. Err on the side of surfacing.
>
> ## Phase 0 — Gather the diff
>
> Run `git diff @{upstream}...HEAD` (or `git diff main...HEAD` / `git diff HEAD~1`
> if there's no upstream) to get the unified diff under review. If there are
> uncommitted changes, or the range diff is empty, also run `git diff HEAD` and
> include the working-tree changes in scope — the review often runs before the
> commit. If a PR number, branch name, or file path was passed as an argument,
> review that target instead. Treat this diff as the review scope.
>
> ## Phase 1 — Find candidates (3 correctness angles + 3 cleanup angles + 1 altitude angle + 1 conventions angle, up to 6 each)
>
> Run **8 independent finder angles** via the Agent tool. Each
> surfaces **up to 6 candidate findings** with `file`, `line`, a one-line
> `summary`, and a concrete `failure_scenario`.
>
> ### Angle A — line-by-line diff scan
>
> Read every hunk in the diff, line by line. Then Read the enclosing function for
> each hunk — bugs in unchanged lines of a touched function are in scope (the PR
> re-exposes or fails to fix them). For every line ask: what input, state, timing,
> or platform makes this line wrong? Look for inverted/wrong conditions,
> off-by-one, null/undefined deref, missing `await`, falsy-zero checks,
> wrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.
>
> ### Angle B — removed-behavior auditor
>
> For every line the diff DELETES or replaces, name the invariant or behavior it
> enforced, then search the new code for where that invariant is re-established.
> If you can't find it, that's a candidate: a removed guard, a dropped error
> path, a narrowed validation, a deleted test that was covering a real case.
>
> ### Angle C — cross-file tracer
>
> For each function the diff changes, find its callers (Grep for the symbol) and
> check whether the change breaks any call site: a new precondition, a changed
> return shape, a new exception, a timing/ordering dependency. Also check callees:
> does a parallel change in the same PR make a call unsafe?
>
> ### Reuse
>
> The angles above hunt for bugs; this one and the next two hunt for cleanup in
> the changed code. Flag new code that re-implements something the codebase
> already has — Grep shared/utility modules and files adjacent to the change,
> and name the existing helper to call instead.
>
> ### Simplification
>
> Flag unnecessary complexity the diff adds: redundant or derivable state,
> copy-paste with slight variation, deep nesting, dead code left behind. Name
> the simpler form that does the same job.
>
> ### Efficiency
>
> Flag wasted work the diff introduces: redundant computation or repeated I/O,
> independent operations run sequentially, blocking work added to startup or
> hot paths. Also flag long-lived objects built from closures or captured
> environments — they keep the entire enclosing scope alive for the object's
> lifetime (a memory leak when that scope holds large values); prefer a
> class/struct that copies only the fields it needs. Name the cheaper
> alternative.
>
> ### Altitude
>
> Check that each change is implemented at the right depth, not as a fragile
> bandaid. Special cases layered on shared infrastructure are a sign the fix
> isn't deep enough — prefer generalizing the underlying mechanism over adding
> special cases.
>
> ### Conventions (CLAUDE.md)
>
> Find the CLAUDE.md files that govern the changed code: the user-level
> ~/.claude/CLAUDE.md, the repo-root CLAUDE.md, plus any CLAUDE.md or
> CLAUDE.local.md in a directory that is an ancestor of a changed file (a
> directory's CLAUDE.md only applies to files at or below it). Read each one
> that exists, then check the diff for clear violations of the rules they state.
> Only flag a violation when you can quote the exact rule and the exact line
> that breaks it — no style preferences, no vague "spirit of the doc"
> inferences. In the finding, name the CLAUDE.md path and quote the rule so the
> report can cite it. If no CLAUDE.md applies, return nothing for this angle.
>
> Cleanup, altitude, and conventions candidates use the same
> `file`/`line`/`summary` shape; in `failure_scenario`, state the concrete
> cost (what is duplicated, wasted, harder to maintain, or which CLAUDE.md rule
> is broken) instead of a crash. Correctness bugs always outrank cleanup,
> altitude, and conventions findings when the output cap forces a cut.
>
> Pass every candidate with a nameable failure scenario through — finders that
> silently drop half-believed candidates bypass the verify step and are the
> dominant cause of misses.
>
> ## Phase 2 — Verify (1-vote, recall-biased)
>
> Dedup near-duplicates (same defect, same location, same reason → keep one). For
> each remaining candidate, run **one verifier** via the Agent tool:
> give it the diff, the relevant file(s), and the candidate; it returns exactly
> one of **CONFIRMED / PLAUSIBLE / REFUTED**.
>
> **PLAUSIBLE by default** — do not refute a candidate for being "speculative" or
> "depends on runtime state" when the state is realistic: concurrency races,
> nil/undefined on a rare-but-reachable path (error handler, cold cache, missing
> optional field), falsy-zero treated as missing, off-by-one on a boundary the
> code does not exclude, retry storms / partial failures, regex/allowlist that
> lost an anchor. These are PLAUSIBLE.
>
> **REFUTED** only when constructible from the code: factually wrong (quote the
> actual line); provably impossible (type/constant/invariant — show it); already
> handled in this diff (cite the guard); or pure style with no observable effect.
>
> Keep **CONFIRMED and PLAUSIBLE**. Drop REFUTED.
>
> ## Output
>
> Return findings as a JSON array of at most 10 objects:
>
>     "file": "path/to/file.ext",
>     "line": 123,
>     "summary": "one-sentence statement of the bug",
>     "failure_scenario": "concrete inputs/state → wrong output/crash",
>     "verdict": "CONFIRMED" | "PLAUSIBLE"
>
> Ranked most-severe first. If more than 10 survive, keep the 10 most
> severe. If nothing survives verification, return `[]`.

---

## Running it here

Dispatch **one subagent** (the Task tool, **`background: false`**) with the chosen tier's prompt as its
whole prompt, plus the review target: the base ref, the branch, and the repo path. That subagent is the
orchestrator of the review — it fans out the 8 finder angles and the verifiers as its own subagents
(each **also `background: false`** — see the block at the top), and returns the JSON array.

Two things about this box specifically:

- **Give it room.** Ten-plus subagents across two phases takes minutes. Use a generous Bash/Task
  timeout and `slack-post` a line so the thread isn't silent. Minutes of silence is normal and
  correct: the whole review runs inside this one turn, because it has nowhere else to run.
- **The Conventions angle reads the target repo's CLAUDE.md, not Percy's.** It resolves them from the
  changed files upward, and the subagent's cwd is `/home/user/work/<repo>` — so it picks up the
  user's repo conventions, which is exactly what you want. Percy's own `~/.claude/CLAUDE.md` doesn't
  govern their code.

## Reporting back

The output is a JSON array, not a Slack message. Turn it into prose: lead with the count and the
worst finding, then each **CONFIRMED** finding as `file:line — what breaks, and on what input`. Keep
the `failure_scenario` — it's the part that makes a finding actionable and the part that proves the
review wasn't a rubber stamp.

**Flag PLAUSIBLE findings separately, at the end of the message, after the confirmed findings have
been reported.** PLAUSIBLE means the verifier found the mechanism real but couldn't pin the trigger —
that's an open question, not a false positive, so don't bury it inside the same list as settled bugs
and don't drop it either. List them under their own short header (e.g. "Also flagged — plausible,
unconfirmed:") with the same `file:line` + `failure_scenario` shape.

If the array is empty, say the review came back clean and say which tier it ran at.
