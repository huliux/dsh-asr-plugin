import { FunAsrError } from "../funasr/errors.js";

/**
 * Punctuation table keyed like the FunASR `punc_list`: index 0 is the unknown
 * slot and index 1 is "no break", so the shared block builders normalize a
 * zero id to the same "no break" mark. Real marks therefore start at index 2.
 */
export const PARAKEET_PUNCTUATION: readonly string[] = Object.freeze([
  "_", "_", ".", ",", "?", "!", ":", ";", "\u2026", "\u2014", ")", "(",
]);

const PUNCTUATION_IDS = new Map(PARAKEET_PUNCTUATION
  .map((mark, index) => [mark, index] as const)
  .filter(([, index]) => index >= 2));

const MAX_TOKENS = 20_000;

export interface ParakeetSpan {
  readonly tokens: readonly string[];
  readonly timestamps: readonly number[];
}

export interface ParakeetChunkText {
  readonly puncInput: string;
  readonly punctuation: {
    readonly ids: readonly number[];
    readonly list: readonly string[];
  };
  readonly rawText: string;
  readonly timestampsMs: readonly (readonly [number, number])[];
  readonly tokens: readonly string[];
  readonly words: readonly string[];
}

interface PendingWord {
  endS: number;
  marks: string;
  startS: number;
  text: string;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}]+$/u;

function isPunctuationOnly(token: string): boolean {
  return PUNCTUATION_ONLY.test(token);
}

function hasLetterOrDigit(token: string): boolean {
  return LETTER_OR_DIGIT.test(token);
}

function punctuationId(mark: string): number {
  return PUNCTUATION_IDS.get(mark) ?? 0;
}

/**
 * Splits the model token stream into words. Each word carries the trailing
 * marks the model emitted, because the sentence block builder needs one
 * break decision per spoken word.
 */
function collectWords(span: ParakeetSpan): PendingWord[] {
  if (span.tokens.length !== span.timestamps.length) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "Parakeet token timestamps do not align");
  }
  if (span.tokens.length > MAX_TOKENS) {
    throw new FunAsrError("RESOURCE_LIMIT", "Too many Parakeet tokens");
  }
  const words: PendingWord[] = [];
  let current: PendingWord | undefined;
  for (let index = 0; index < span.tokens.length; index += 1) {
    const token = span.tokens[index]!;
    const startS = span.timestamps[index]!;
    const endS = span.timestamps[index] ?? startS;
    if (!Number.isFinite(startS) || !Number.isFinite(endS) || startS < 0 || endS < startS) {
      throw new FunAsrError("MODEL_INFERENCE_FAILED", "Parakeet timestamps are invalid");
    }
    if (token === "") throw new FunAsrError("MODEL_INFERENCE_FAILED", "Parakeet returned an empty token");
    if (isPunctuationOnly(token)) {
      if (current !== undefined) current.marks += token;
      continue;
    }
    const startsWord = token.startsWith(" ") || current === undefined;
    if (startsWord || current === undefined) {
      current = { endS, marks: "", startS, text: token.replace(/^\s+/u, "") };
      words.push(current);
    } else {
      current.text += token;
      current.endS = Math.max(current.endS, endS);
    }
    if (!hasLetterOrDigit(current.text)) {
      throw new FunAsrError("MODEL_INFERENCE_FAILED", "Parakeet returned an invalid token");
    }
  }
  return words;
}

/**
 * Builds the word-level view of one speech chunk. Offsets are relative to the
 * chunk so the shared block and token-unit builders can place them on the
 * meeting timeline.
 */
export function parakeetChunkText(span: ParakeetSpan, durationMs: number): ParakeetChunkText {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "Parakeet chunk duration is invalid");
  }
  const words = collectWords(span).map((word) => ({ ...word }));
  for (const word of words) {
    if (word.text.trim() !== "" && !hasLetterOrDigit(word.text)) {
      throw new FunAsrError("MODEL_INFERENCE_FAILED", "Parakeet returned an invalid token");
    }
  }
  const kept = words.filter((word) => word.text.trim() !== "");
  const tokens: string[] = [];
  const ids: number[] = [];
  const timestampsMs: Array<readonly [number, number]> = [];
  let previousEnd = 0;
  for (const [index, word] of kept.entries()) {
    const start = Math.min(durationMs - 1, Math.max(previousEnd, Math.round(word.startS * 1_000)));
    // Sherpa reports the onset of each token, so a word runs until the next
    // word starts; the last word runs to the end of the chunk.
    const nextStartS = kept[index + 1]?.startS ?? durationMs / 1_000;
    const rawEnd = Math.round(Math.max(word.endS, nextStartS) * 1_000);
    const end = Math.min(durationMs, Math.max(start + 1, rawEnd));
    tokens.push(word.text);
    ids.push(punctuationId(word.marks.trim().slice(-1)));
    timestampsMs.push([start, end]);
    previousEnd = end;
  }
  if (tokens.length === 0) {
    return {
      puncInput: "",
      punctuation: { ids: [], list: PARAKEET_PUNCTUATION },
      rawText: "",
      timestampsMs: [],
      tokens: [],
      words: [],
    };
  }
  return {
    puncInput: kept.map((word) => word.text).join(" "),
    punctuation: { ids, list: PARAKEET_PUNCTUATION },
    rawText: tokens.join(" "),
    timestampsMs,
    tokens,
    words: kept.map((word) => word.text),
  };
}
