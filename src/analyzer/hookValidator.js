/**
 * hookValidator.js
 * ================
 * Enforces: hook = first sentence / first 10–15 words of the Whisper transcript.
 *
 * Place in: src/analyzer/hookValidator.js
 *
 * GPT often picks the "punchiest" line from the middle of the transcript.
 * This module catches that and falls back to the actual opening line.
 */

import { workerLogger } from "../core/logger.js";

// ─── CONFIG ───────────────────────────────────────────────────
const SIMILARITY_THRESHOLD = 0.6;
const FIRST_N_WORDS_DEFAULT = 12;
const SUBSTRING_WINDOW = 25;

// ─── HELPERS ──────────────────────────────────────────────────

function clean(text) {
  return (text || "").trim().replace(/\s+/g, " ");
}

function firstSentence(transcript) {
  const t = clean(transcript);
  const match = t.match(/^(.+?[.!?])(?:\s|$)/);
  return match ? match[1].trim() : firstNWords(t);
}

function firstNWords(transcript, n = FIRST_N_WORDS_DEFAULT) {
  const words = clean(transcript).split(" ");
  return words.slice(0, n).join(" ");
}

/**
 * Dice-coefficient bigram similarity (zero dependencies).
 */
function similarity(a, b) {
  const cleanA = clean(a).toLowerCase();
  const cleanB = clean(b).toLowerCase();
  if (cleanA === cleanB) return 1.0;
  if (cleanA.length < 2 || cleanB.length < 2) return 0.0;

  const bigramsA = new Map();
  for (let i = 0; i < cleanA.length - 1; i++) {
    const bigram = cleanA.substring(i, i + 2);
    bigramsA.set(bigram, (bigramsA.get(bigram) || 0) + 1);
  }

  let intersection = 0;
  for (let i = 0; i < cleanB.length - 1; i++) {
    const bigram = cleanB.substring(i, i + 2);
    const count = bigramsA.get(bigram) || 0;
    if (count > 0) {
      intersection++;
      bigramsA.set(bigram, count - 1);
    }
  }

  return (2.0 * intersection) / (cleanA.length - 1 + (cleanB.length - 1));
}

function isSubstringOfStart(hook, transcript) {
  const region = firstNWords(transcript, SUBSTRING_WINDOW).toLowerCase();
  return region.includes(clean(hook).toLowerCase());
}

// ─── MAIN VALIDATOR ───────────────────────────────────────────

/**
 * Validate GPT's hook against the Whisper transcript.
 *
 * @param {string|null} gptHook    - hook text GPT returned
 * @param {string}      transcript - full Whisper transcript
 * @returns {{ hook: string|null, source: string, score: number, reason: string }}
 */
export function validateHook(gptHook, transcript) {
  transcript = clean(transcript);

  if (!transcript) {
    return {
      hook: null,
      source: "none",
      score: 0,
      reason: "Empty transcript.",
    };
  }

  const startRegion = firstNWords(transcript, 15);

  // ── 1. GPT hook provided → validate it ──
  if (gptHook && clean(gptHook).length > 0) {
    gptHook = clean(gptHook);

    // Check A: substring of transcript start?
    if (isSubstringOfStart(gptHook, transcript)) {
      const sim = similarity(gptHook, startRegion);
      workerLogger.debug(
        `[HookValidator] GPT hook ACCEPTED (substring match, sim=${(sim * 100).toFixed(1)}%)`,
      );
      return {
        hook: gptHook,
        source: "gpt",
        score: sim,
        reason: "GPT hook is substring of transcript start.",
      };
    }

    // Check B: high similarity?
    const sim = similarity(gptHook, startRegion);
    if (sim >= SIMILARITY_THRESHOLD) {
      workerLogger.debug(
        `[HookValidator] GPT hook ACCEPTED (sim=${(sim * 100).toFixed(1)}%)`,
      );
      return {
        hook: gptHook,
        source: "gpt",
        score: sim,
        reason: `Similarity ${(sim * 100).toFixed(1)}% >= threshold.`,
      };
    }

    // ── REJECTED ──
    workerLogger.warn(
      `[HookValidator] GPT hook REJECTED (sim=${(sim * 100).toFixed(1)}%): "${gptHook.substring(0, 80)}..."`,
    );
  }

  // ── 2. Fallback: first sentence ──
  const sentence = firstSentence(transcript);
  const wordCount = sentence.split(" ").length;

  if (wordCount >= 5 && wordCount <= 25) {
    workerLogger.info(
      `[HookValidator] Fallback → first sentence (${wordCount} words)`,
    );
    return {
      hook: sentence,
      source: "first_sentence",
      score: 1.0,
      reason: `Fallback to first sentence (${wordCount} words).`,
    };
  }

  // ── 3. Fallback: first N words ──
  const words = firstNWords(transcript, FIRST_N_WORDS_DEFAULT);
  if (words) {
    workerLogger.info(
      `[HookValidator] Fallback → first ${FIRST_N_WORDS_DEFAULT} words`,
    );
    return {
      hook: words,
      source: "first_n_words",
      score: 1.0,
      reason: `Fallback to first ${FIRST_N_WORDS_DEFAULT} words.`,
    };
  }

  return {
    hook: null,
    source: "none",
    score: 0,
    reason: "All fallbacks failed.",
  };
}

export default validateHook;
