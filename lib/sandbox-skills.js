import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { CLAUDE_DIR } from "./sandbox-guardrails.js";

/**
 * The skills JoeStar gets when its thread's sandbox is created, shipped from
 * `toolkit/skills/` in this repo into `~/.claude/skills/` in the sandbox. Once
 * per box, not once per message: the box is paused between turns and comes back
 * with them still on disk.
 *
 * WHY THESE ARE FILES AND NOT STRINGS. Everything else we install into the
 * sandbox — the memory file, the push-guard hook — is a JS string constant,
 * specifically so Vercel's bundler has nothing to trace or leave behind. Skills
 * break that pattern on purpose: they are prose that gets edited far more often
 * than the code around them, they come as directories (a SKILL.md plus whatever
 * references/ or scripts/ it carries), and a skill you have to re-encode into a
 * template literal before it ships is a skill nobody will edit. The cost of that
 * choice is the bundler problem below, which is worth paying once here.
 *
 * WHY vercel.json NEEDS includeFiles. Vercel's bundler only packages files it
 * can statically see being imported. This module reads a directory at runtime,
 * which it cannot see, so without `includeFiles: "toolkit/**"` in vercel.json
 * the folder is simply absent from the deployed function and a box is
 * provisioned with zero skills — with no error, because a missing directory
 * reads the same as an empty one. That entry in vercel.json is load-bearing;
 * deleting it breaks this quietly.
 *
 * Installing once rather than every run makes that failure STICKY, which is the
 * second reason the init-event log in runClaude matters: a thread whose box came
 * up skill-less stays skill-less for its whole life, and a redeploy repairs new
 * threads while doing nothing for the one you are watching. Same shape as the
 * Exa registration and the persona file — the fix is a version stamp on the box,
 * which this repo doesn't have.
 */

// Where they land in the sandbox: user-level, so they load no matter what
// directory the agent happens to be standing in. Same reasoning as CLAUDE.md —
// there is no project checked out in this container to discover them from.
const SKILLS_DIR = `${CLAUDE_DIR}/skills`;

// Path within the repo/deployment, relative to whichever root we find below.
const SOURCE_DIR = join("toolkit", "skills");

/**
 * Guards against a mistake in the toolkit folder turning into a slow, expensive
 * upload. Once per thread now rather than once per message, but the turn that
 * pays it is the FIRST one — the cold-create the user is already waiting on —
 * so the ceiling still earns its keep. Skills are prose; anything approaching
 * this is a stray build artifact or a committed binary, not a skill.
 */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/**
 * Roots to look for `toolkit/skills` under.
 *
 * Two candidates rather than one because the answer genuinely differs between
 * environments: locally the process starts at the repo root, while on Vercel the
 * function runs from a task root that `includeFiles` mirrors the repo into.
 * `__dirname` is the belt to cwd's braces — it exists when the bundler emits
 * CommonJS (which it does; see the chalk override in package.json for a prior
 * run-in with that) and is simply skipped when it doesn't.
 */
function candidateRoots() {
  const roots = [process.cwd()];
  if (typeof __dirname !== "undefined") roots.push(join(__dirname, ".."));
  return roots;
}

function findSourceDir() {
  for (const root of candidateRoots()) {
    const candidate = join(root, SOURCE_DIR);
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Not here — try the next root.
    }
  }
  return null;
}

/**
 * Walks a skill directory into `{ relativePath, data }` entries, keeping the
 * tree shape so a skill's supporting files (references/, scripts/) arrive
 * alongside its SKILL.md instead of being flattened into it.
 *
 * Read as UTF-8 text, not bytes: skills are markdown and scripts. A skill that
 * needs to ship a binary is doing something this loader isn't for.
 */
function collectFiles(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Skip the junk that accumulates in an edited-by-hand folder: macOS's
    // .DS_Store would otherwise be uploaded into every sandbox forever.
    if (entry.name.startsWith(".")) continue;

    const absolute = join(dir, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) files.push(...collectFiles(absolute, relative));
    else if (entry.isFile()) files.push({ relativePath: relative, data: readFileSync(absolute, "utf8") });
  }
  return files;
}

/**
 * Builds the `{ path, data }` entries to hand to `sandbox.files.write`.
 *
 * Returns an empty array rather than throwing when there is nothing to install:
 * a missing or empty toolkit folder is a reason for the bot to run without
 * skills, not a reason for it to stop answering Slack. It logs loudly instead,
 * because the failure this guards against — the bundler silently dropping
 * `toolkit/` — is otherwise invisible from the outside.
 *
 * @returns {{path: string, data: string}[]}
 */
export function buildSkillFiles() {
  const source = findSourceDir();
  if (!source) {
    console.error(
      `skills: no ${SOURCE_DIR} directory found under ${candidateRoots().join(", ")} — installing none`,
    );
    return [];
  }

  // One level of directories, each a skill. A loose file sitting directly in
  // toolkit/skills isn't a skill — Claude Code only discovers
  // skills/<name>/SKILL.md — so flag it rather than uploading it somewhere it
  // will never be read.
  const entries = readdirSync(source, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) {
      console.warn(`skills: ignoring loose file ${entry.name} — skills must be a directory with a SKILL.md`);
      continue;
    }
    skills.push(entry.name);
  }

  const files = [];
  let totalBytes = 0;
  for (const name of skills) {
    const collected = collectFiles(join(source, name));

    // A directory without a SKILL.md is invisible to Claude Code no matter what
    // else is in it, so say so here rather than letting the agent come up
    // missing a skill someone believes they installed.
    if (!collected.some((f) => f.relativePath === "SKILL.md")) {
      console.warn(`skills: ${name}/ has no SKILL.md — it will not be discovered`);
    }

    for (const file of collected) {
      totalBytes += Buffer.byteLength(file.data, "utf8");
      files.push({ path: `${SKILLS_DIR}/${name}/${file.relativePath}`, data: file.data });
    }
  }

  if (totalBytes > MAX_TOTAL_BYTES) {
    console.error(
      `skills: ${Math.round(totalBytes / 1024)}KB exceeds the ${MAX_TOTAL_BYTES / 1024}KB budget — installing none`,
    );
    return [];
  }

  console.log(`skills: installing ${skills.length} (${files.length} files, ${Math.round(totalBytes / 1024)}KB)`);
  return files;
}
