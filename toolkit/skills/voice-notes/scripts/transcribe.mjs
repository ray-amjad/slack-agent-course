#!/usr/bin/env node
/**
 * ElevenLabs Scribe v2 → text. The one command the `voice-notes` skill runs.
 *
 * Deliberately a script and not a curl line in the SKILL.md. Three reasons, each
 * of which is a failure this avoids:
 *
 *   1. The response is JSON, and this box has no `jq` — a hand-rolled curl leaves
 *      the model parsing a 40KB word-timestamp array out of its own tool output.
 *   2. A wrong or missing key comes back as a JSON error body with HTTP 401, not
 *      as a non-zero exit. `curl -f` alone would report "exit 22" and nothing
 *      about which of the several possible causes it was.
 *   3. It pins the model id in exactly one place. `scribe_v1` is still accepted
 *      by the API, so a typo downgrades quality silently rather than erroring.
 *
 * stdout is the transcript and NOTHING else, so it pipes and greps cleanly.
 * Everything about the transcription (language, duration, retries) goes to
 * stderr — the Bash tool shows the model both, so nothing is lost.
 *
 * Usage:
 *   node transcribe.mjs <audio-file> [--language eng] [--diarize] [--clean]
 *                       [--json] [--timeout ms]
 *
 * Exit codes: 0 transcript, 1 API/network failure, 2 usage or missing key.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";

// Scribe v2 — the current batch model. The API also still accepts `scribe_v1`,
// which is why this is a constant: a silent downgrade is worse than an error.
const MODEL_ID = "scribe_v2";

// Generous next to the seconds a Slack voice note actually takes, but well
// inside the run's own 10-minute ceiling so a hung request fails here — with a
// message — rather than by taking the whole Slack turn down with it.
const DEFAULT_TIMEOUT_MS = 180_000;

// One retry, for the transient classes only (429, 5xx, network). A second
// attempt costs three seconds; a failed voice note costs the user the turn.
const RETRY_DELAY_MS = 3000;

function die(code, message) {
  console.error(`transcribe: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    file: null,
    language: null,
    diarize: false,
    clean: false,
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--diarize") opts.diarize = true;
    else if (arg === "--clean") opts.clean = true;
    else if (arg === "--json") opts.json = true;
    // Explicit, because the silent version of this is nasty: `--language` as
    // the last argument sets `undefined`, `language_code` is simply never sent,
    // and you get a plausible auto-detected transcript instead of an error —
    // for the exact short/noisy clips the flag exists to rescue.
    else if (arg === "--language") {
      opts.language = argv[++i];
      if (!opts.language) die(2, "--language needs a code, e.g. --language eng");
    } else if (arg === "--timeout") opts.timeoutMs = Number(argv[++i]);
    else if (arg.startsWith("-")) die(2, `unknown flag ${arg}`);
    else if (opts.file) die(2, "one file at a time — call this once per attachment");
    else opts.file = arg;
  }

  if (!opts.file) die(2, "usage: transcribe.mjs <audio-file> [--language eng] [--diarize] [--clean] [--json]");
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) die(2, "--timeout must be a positive number of ms");
  return opts;
}

async function buildForm(opts) {
  let bytes;
  try {
    bytes = await readFile(opts.file);
  } catch (err) {
    die(2, `cannot read ${opts.file}: ${err.message}`);
  }
  if (!bytes.length) die(2, `${opts.file} is empty — nothing to transcribe`);

  const form = new FormData();
  // The filename matters: ElevenLabs infers the container from its extension,
  // so stripping it (or sending a bare Blob) turns an m4a into an unknown blob.
  form.append("file", new Blob([bytes]), basename(opts.file));
  form.append("model_id", MODEL_ID);
  if (opts.language) form.append("language_code", opts.language);
  if (opts.diarize) form.append("diarize", "true");
  // no_verbatim drops filler words and false starts. Off by default: a voice
  // note is the user's own words, and "clean" is a lossy edit of them.
  if (opts.clean) form.append("no_verbatim", "true");
  return { form, byteLength: bytes.length };
}

/** True for the failures a second attempt could plausibly fix. */
function isTransient(status) {
  return status === 429 || status >= 500;
}

async function post(form, timeoutMs, apiKey) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.ok) return { ok: true, body: await res.json() };

  // Error bodies are JSON (`{ detail: { status, message } }`) but not
  // guaranteed to be, so read as text and don't let a parse failure become the
  // error the user hears about.
  const text = (await res.text().catch(() => "")).slice(0, 500);
  return { ok: false, status: res.status, text };
}

/**
 * Renders `speaker_0: …` blocks from the word list. Only used with --diarize:
 * the API's own `text` field is a single flat string, so who-said-what is
 * reconstructible only from the per-word speaker ids.
 */
function renderDiarized(words = []) {
  const blocks = [];
  for (const word of words) {
    if (word.type === "audio_event") continue;
    const speaker = word.speaker_id ?? "speaker_0";
    const last = blocks.at(-1);
    if (last && last.speaker === speaker) last.text += word.text;
    else blocks.push({ speaker, text: word.text });
  }
  return blocks
    .map((b) => `${b.speaker}: ${b.text.trim()}`)
    .filter((line) => !line.endsWith(": "))
    .join("\n\n");
}

const opts = parseArgs(process.argv.slice(2));

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  die(
    2,
    "ELEVENLABS_API_KEY is not set in this sandbox. Transcription is off for this run — " +
      "tell the user the key is missing rather than guessing at the audio.",
  );
}

const { form, byteLength } = await buildForm(opts);

// A thrown fetch — DNS blip, ECONNRESET, the AbortSignal firing — is as
// transient as a 503, and used to be the one class that skipped the retry
// entirely: it escaped straight to `die`, so a single dropped connection cost
// the user their whole voice note. Both kinds of transient now take the same
// path, and only a second failure is terminal.
let result;
let firstError = null;
try {
  result = await post(form, opts.timeoutMs, apiKey);
} catch (err) {
  firstError = err;
}

if (firstError || (!result.ok && isTransient(result.status))) {
  const why = firstError ? firstError.message : `HTTP ${result.status}`;
  console.error(`transcribe: ${why} — retrying once in ${RETRY_DELAY_MS / 1000}s`);
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  try {
    // FormData is single-use once consumed by fetch, so the retry rebuilds it.
    result = await post((await buildForm(opts)).form, opts.timeoutMs, apiKey);
  } catch (err) {
    die(1, `request failed twice: ${err.message}`);
  }
}

if (!result.ok) {
  const hint =
    result.status === 401
      ? " — the ELEVENLABS_API_KEY in this sandbox is rejected; it needs re-issuing, not retrying"
      : "";
  die(1, `HTTP ${result.status}${hint}\n${result.text}`);
}

const data = result.body;

if (opts.json) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  process.exit(0);
}

// Diarization degrades to the plain transcript rather than to nothing.
// `renderDiarized` returns "" whenever the response has no `words` (or only
// `audio_event` entries), which then hits the empty-transcript branch below and
// announces that the audio was silent — while `data.text` holds a perfectly
// good transcript of it. Wrong answer, delivered confidently.
const plain = (data.text ?? "").trim();
let transcript = plain;
if (opts.diarize) {
  transcript = renderDiarized(data.words);
  if (!transcript && plain) {
    console.error("transcribe: no per-word speaker data in the response — falling back to plain text");
    transcript = plain;
  }
}

const meta = [
  `model=${MODEL_ID}`,
  `bytes=${byteLength}`,
  data.language_code ? `language=${data.language_code}` : null,
  typeof data.language_probability === "number"
    ? `confidence=${data.language_probability.toFixed(2)}`
    : null,
  typeof data.audio_duration_secs === "number"
    ? `duration=${data.audio_duration_secs.toFixed(1)}s`
    : null,
]
  .filter(Boolean)
  .join(" ");
console.error(`transcribe: ${meta}`);

// A successful call on silence returns an empty string. Say so on stderr — the
// model otherwise sees a clean exit with no output and has to guess whether the
// transcription failed or the recording was genuinely quiet.
if (!transcript) {
  console.error("transcribe: transcript is empty — the audio contained no detectable speech");
  process.exit(0);
}

process.stdout.write(`${transcript}\n`);
