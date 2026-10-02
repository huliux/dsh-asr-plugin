import { FunAsrError } from "./errors.js";

export interface FunAsrPostprocessedText {
  readonly sentence: string;
  readonly tokens: string[];
}

export interface FunAsrPostprocessedWithTimestamps extends FunAsrPostprocessedText {
  readonly timestamps: Array<[number, number]>;
}

export interface FunAsrSentenceBlock {
  readonly endMs: number;
  readonly startMs: number;
  readonly text: string;
}

export interface FunAsrTokenUnit {
  readonly breakAfter: boolean;
  readonly endMs: number;
  readonly startMs: number;
  readonly text: string;
}

const SPECIAL_TOKENS = new Set(["<s>", "</s>", "<unk>"]);

function isChineseOrDigit(value: string): boolean {
  const characters = Array.from(value.replaceAll(" ", ""));
  return characters.length > 0 && characters.every((character) =>
    (character >= "\u4e00" && character <= "\u9fff") || /[0-9]/.test(character));
}

function isAlpha(value: string): boolean {
  const stripped = value.replaceAll(" ", "").replaceAll("</s>", "").replaceAll("<s>", "");
  return stripped.length > 0 && /^[A-Za-z']+$/.test(stripped);
}

function validWords(words: readonly string[]): string[] {
  return words.filter((word) => !SPECIAL_TOKENS.has(word));
}

function mixedWordList(words: readonly string[]): string[] {
  const output: string[] = [];
  let pendingAlpha = "";
  let hasAlphaBlank = false;
  for (const word of words) {
    if (isChineseOrDigit(word)) {
      if (pendingAlpha !== "") {
        output.push(pendingAlpha, " ");
        pendingAlpha = "";
        hasAlphaBlank = true;
      }
      if (hasAlphaBlank) output.pop();
      output.push(word);
      hasAlphaBlank = false;
    } else if (word.includes("@@")) {
      pendingAlpha += word.replaceAll("@@", "");
      hasAlphaBlank = false;
    } else if (isAlpha(word)) {
      output.push(`${pendingAlpha}${word}`, " ");
      pendingAlpha = "";
      hasAlphaBlank = true;
    } else {
      throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR returned an invalid token");
    }
  }
  if (pendingAlpha !== "") output.push(pendingAlpha);
  return output;
}

function plainWordList(words: readonly string[]): string[] {
  if (words.every(isChineseOrDigit)) return words.map((word) => word.replaceAll(" ", ""));
  if (!words.every(isAlpha)) return mixedWordList(words);
  const output: string[] = [];
  let pending = "";
  for (const word of words) {
    pending += word.replaceAll("@@", "");
    if (!word.includes("@@")) {
      output.push(pending, " ");
      pending = "";
    }
  }
  if (pending !== "") output.push(pending);
  return output;
}

function appendCompletedAlpha(
  output: string[],
  outputTimestamps: Array<[number, number]>,
  word: string,
  begin: number,
  end: number,
): void {
  output.push(word, " ");
  outputTimestamps.push([begin, end]);
}

function timestampedAlphaWords(
  words: readonly string[],
  timestamps: readonly (readonly [number, number])[],
): { timestamps: Array<[number, number]>; words: string[] } {
  const output: string[] = [];
  const outputTimestamps: Array<[number, number]> = [];
  let pending = "";
  let begin = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (pending === "") begin = timestamps[index]![0];
    pending += word.replaceAll("@@", "");
    if (!word.includes("@@")) {
      appendCompletedAlpha(output, outputTimestamps, pending, begin, timestamps[index]![1]);
      pending = "";
    }
  }
  return { timestamps: outputTimestamps, words: output };
}

function timestampedMixedWords(
  words: readonly string[],
  timestamps: readonly (readonly [number, number])[],
): { timestamps: Array<[number, number]>; words: string[] } {
  const output: string[] = [];
  const outputTimestamps: Array<[number, number]> = [];
  let pending = "";
  let begin = 0;
  let pendingEnd = 0;
  let hasAlphaBlank = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const timestamp = timestamps[index]!;
    if (isChineseOrDigit(word)) {
      if (pending !== "") {
        appendCompletedAlpha(output, outputTimestamps, pending, begin, pendingEnd);
        pending = "";
        hasAlphaBlank = true;
      }
      if (hasAlphaBlank) output.pop();
      output.push(word);
      outputTimestamps.push([timestamp[0], timestamp[1]]);
      hasAlphaBlank = false;
    } else if (word.includes("@@")) {
      if (pending === "") begin = timestamp[0];
      pending += word.replaceAll("@@", "");
      pendingEnd = timestamp[1];
      hasAlphaBlank = false;
    } else if (isAlpha(word)) {
      if (pending === "") begin = timestamp[0];
      appendCompletedAlpha(output, outputTimestamps, `${pending}${word}`, begin, timestamp[1]);
      pending = "";
      hasAlphaBlank = true;
    } else {
      throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR returned an invalid token");
    }
  }
  if (pending !== "") {
    appendCompletedAlpha(output, outputTimestamps, pending, begin, pendingEnd);
  }
  return { timestamps: outputTimestamps, words: output };
}

function timestampedWordList(
  words: readonly string[],
  timestamps: readonly (readonly [number, number])[],
): { timestamps: Array<[number, number]>; words: string[] } {
  if (words.every(isChineseOrDigit)) {
    return {
      timestamps: timestamps.map(([start, end]) => [start, end]),
      words: words.map((word) => word.replaceAll(" ", "")),
    };
  }
  return words.every(isAlpha)
    ? timestampedAlphaWords(words, timestamps)
    : timestampedMixedWords(words, timestamps);
}

function timestampIndexes(words: readonly string[]): number[] {
  const indexes: number[] = [];
  let timestampIndex = 0;
  for (const word of words) {
    indexes.push(timestampIndex);
    if (word !== " ") timestampIndex += 1;
  }
  return indexes;
}

function splitTimestamp(begin: number, end: number, count: number): Array<[number, number]> {
  if (count <= 0) return [];
  if (!Number.isFinite(begin) || !Number.isFinite(end) || end <= begin) {
    return Array.from({ length: count }, () => [begin, end]);
  }
  const span = Math.max(count, end - begin);
  return Array.from({ length: count }, (_, index) => {
    const start = begin + Math.round((span * index) / count);
    const finish = begin + Math.round((span * (index + 1)) / count);
    return [start, Math.max(start + 1, finish)];
  });
}

function abbreviationEnd(words: readonly string[], start: number): number {
  if (!/^[A-Za-z]$/.test(words[start] ?? "")) return start;
  let end = start;
  while (words[end + 1] === " " && /^[A-Za-z]$/.test(words[end + 2] ?? "")) end += 2;
  return end;
}

function disposeAbbreviations(
  words: readonly string[],
  timestamps?: readonly (readonly [number, number])[],
): { timestamps: Array<[number, number]>; words: string[] } {
  const output: string[] = [];
  const outputTimestamps: Array<[number, number]> = [];
  const indexes = timestampIndexes(words);
  for (let index = 0; index < words.length; index += 1) {
    const end = abbreviationEnd(words, index);
    if (end > index) {
      const letters = words.slice(index, end + 1).filter((word) => word !== " ");
      output.push(...letters.map((letter) => letter.toUpperCase()));
      if (timestamps !== undefined) {
        const beginTs = timestamps[indexes[index]!]!;
        const endTs = timestamps[indexes[end]!]!;
        outputTimestamps.push(...splitTimestamp(beginTs[0], endTs[1], letters.length));
      }
      index = end;
    } else {
      output.push(words[index]!);
      if (timestamps !== undefined && words[index] !== " ") {
        const timestamp = timestamps[indexes[index]!]!;
        outputTimestamps.push([timestamp[0], timestamp[1]]);
      }
    }
  }
  return { timestamps: outputTimestamps, words: output };
}

function assertTimestamps(
  words: readonly string[],
  timestamps: readonly (readonly [number, number])[],
): void {
  if (words.length !== timestamps.length) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR token timestamps do not align");
  }
  let previous = 0;
  for (const [start, end] of timestamps) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < previous || end <= start) {
      throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR token timestamps are invalid");
    }
    previous = end;
  }
}

export function sentencePostprocess(words: readonly string[]): FunAsrPostprocessedText {
  const middle = validWords(words);
  if (middle.length === 0) return { sentence: "", tokens: [] };
  const disposed = disposeAbbreviations(plainWordList(middle));
  return {
    sentence: disposed.words.join("").trim(),
    tokens: disposed.words.filter((word) => word !== " "),
  };
}

export function sentencePostprocessWithTimestamps(
  words: readonly string[],
  timestamps: readonly (readonly [number, number])[],
): FunAsrPostprocessedWithTimestamps {
  assertTimestamps(words, timestamps);
  const keptIndexes = words.flatMap((word, index) => SPECIAL_TOKENS.has(word) ? [] : [index]);
  const middle = keptIndexes.map((index) => words[index]!);
  const middleTimestamps = keptIndexes.map((index) => timestamps[index]!);
  if (middle.length === 0) return { sentence: "", timestamps: [], tokens: [] };
  const normalized = timestampedWordList(middle, middleTimestamps);
  const disposed = disposeAbbreviations(normalized.words, normalized.timestamps);
  const tokens = disposed.words.filter((word) => word !== " ");
  return { sentence: tokens.join(" ").trim(), timestamps: disposed.timestamps, tokens };
}

export function splitToMiniSentences<T>(words: readonly T[], wordLimit = 20): T[][] {
  if (!Number.isSafeInteger(wordLimit) || wordLimit <= 1) {
    throw new FunAsrError("ASSET_MISMATCH", "Invalid FunASR punctuation window");
  }
  const output: T[][] = [];
  for (let index = 0; index < words.length; index += wordLimit) {
    output.push(words.slice(index, index + wordLimit));
  }
  return output.length === 0 ? [[]] : output;
}

export function codeMixSplitWords(text: string): string[] {
  const output: string[] = [];
  for (const segment of text.trim().split(/\s+/).filter(Boolean)) {
    let ascii = "";
    for (const character of segment) {
      if (character.charCodeAt(0) <= 0x7f) {
        ascii += character;
      } else {
        if (ascii !== "") output.push(ascii);
        output.push(character);
        ascii = "";
      }
    }
    if (ascii !== "") output.push(ascii);
  }
  return output;
}

export function appendToken(current: string, token: string): string {
  if (token === "") return current;
  if (/^[A-Za-z0-9]/.test(token) || /[A-Za-z0-9]$/.test(current)) return `${current} ${token}`;
  return `${current}${token}`;
}

function punctuationFor(id: number, punctuationList: readonly string[]): string {
  const normalized = Number.isSafeInteger(id) ? Math.max(1, id) : 1;
  return punctuationList[normalized] ?? "_";
}

export function buildTokenUnits(
  tokens: readonly string[],
  timestamps: readonly (readonly [number, number])[],
  punctuationIds: readonly number[],
  punctuationList: readonly string[],
  chunkStartMs: number,
  chunkEndMs: number,
): FunAsrTokenUnit[] {
  assertTimestamps(tokens, timestamps);
  if (punctuationIds.length !== tokens.length || chunkStartMs < 0 || chunkEndMs <= chunkStartMs) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR token unit inputs are invalid");
  }
  const units = tokens.map((token, index) => {
    const punctuation = punctuationFor(punctuationIds[index]!, punctuationList);
    return {
      breakAfter: punctuation !== "_",
      endMs: Math.min(chunkEndMs, chunkStartMs + timestamps[index]![1]),
      startMs: Math.min(chunkEndMs, chunkStartMs + timestamps[index]![0]),
      text: punctuation === "_" ? token : `${token}${punctuation}`,
    };
  });
  if (units.some((unit) => unit.text.trim() === "" || unit.endMs <= unit.startMs)) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR token unit is invalid");
  }
  return units;
}

export function buildSentenceBlocks(
  tokens: readonly string[],
  timestamps: readonly (readonly [number, number])[],
  punctuationIds: readonly number[],
  punctuationList: readonly string[],
  chunkStartMs: number,
  chunkEndMs: number,
): FunAsrSentenceBlock[] {
  assertTimestamps(tokens, timestamps);
  if (punctuationIds.length !== tokens.length || chunkStartMs < 0 || chunkEndMs <= chunkStartMs) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR sentence block inputs are invalid");
  }
  const blocks: FunAsrSentenceBlock[] = [];
  let text = "";
  let start = timestamps[0]?.[0] ?? 0;
  for (let index = 0; index < tokens.length; index += 1) {
    text = appendToken(text, tokens[index]!);
    const punctuation = punctuationFor(punctuationIds[index]!, punctuationList);
    if (punctuation !== "_") text += punctuation;
    if (punctuation !== "_" || index === tokens.length - 1) {
      const end = timestamps[index]![1];
      blocks.push({
        endMs: Math.min(chunkEndMs, chunkStartMs + end),
        startMs: Math.min(chunkEndMs, chunkStartMs + start),
        text: text.trim(),
      });
      text = "";
      start = timestamps[index + 1]?.[0] ?? end;
    }
  }
  if (blocks.some((block) => block.text === "" || block.endMs <= block.startMs)) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR sentence block is invalid");
  }
  return blocks;
}

export class TokenIdConverter {
  readonly #tokenList: readonly string[];
  readonly #tokenToId: Map<string, number>;
  readonly #unknownId: number;

  constructor(tokenList: readonly string[]) {
    if (tokenList.length === 0 || tokenList.at(-1) !== "<unk>" || new Set(tokenList).size !== tokenList.length) {
      throw new FunAsrError("ASSET_MISMATCH", "Invalid FunASR token list");
    }
    this.#tokenList = tokenList;
    this.#tokenToId = new Map(tokenList.map((token, index) => [token, index]));
    this.#unknownId = tokenList.length - 1;
  }

  idsToTokens(ids: Iterable<number>): string[] {
    return Array.from(ids, (id) => this.#tokenList[id] ?? "<unk>");
  }

  tokensToIds(tokens: Iterable<string>): number[] {
    return Array.from(tokens, (token) => this.#tokenToId.get(token) ?? this.#unknownId);
  }
}
