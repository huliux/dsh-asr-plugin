import { readFile } from "node:fs/promises";
import * as ort from "onnxruntime-node";

import {
  parseFunAsrPunctuationConfig,
  parseTokenList,
} from "./config.js";
import type { FunAsrPunctuationConfig } from "./config.js";
import { FunAsrError } from "./errors.js";
import { argmaxRows, createSession, disposeResults, requireFloatTensor } from "./onnx.js";
import type { FunAsrPunctuator } from "./pipeline.js";
import { codeMixSplitWords, splitToMiniSentences, TokenIdConverter } from "./text.js";

const INPUT_NAMES = ["inputs", "text_lengths"] as const;
const OUTPUT_NAMES = ["logits"] as const;
const PUNCTUATION_VOCAB_SIZE = 272_727;
const PUNCTUATION_CLASSES = 6;
const SPLIT_SIZE = 20;
const CACHE_LIMIT = 200;

export interface FunAsrPunctuatorPaths {
  readonly configPath: string;
  readonly modelPath: string;
  readonly tokensPath: string;
}

interface PunctuatorAssets {
  readonly config: FunAsrPunctuationConfig;
  readonly tokens: TokenIdConverter;
}

interface WindowState {
  readonly ids: number[];
  readonly words: string[];
}

async function readAssets(paths: FunAsrPunctuatorPaths): Promise<PunctuatorAssets> {
  try {
    const [configText, tokenJson] = await Promise.all([
      readFile(paths.configPath, "utf8"),
      readFile(paths.tokensPath, "utf8"),
    ]);
    const tokenList = parseTokenList(tokenJson);
    if (tokenList.length !== PUNCTUATION_VOCAB_SIZE) {
      throw new FunAsrError("ASSET_MISMATCH", "FunASR punctuation vocabulary size drifted");
    }
    return {
      config: parseFunAsrPunctuationConfig(configText),
      tokens: new TokenIdConverter(tokenList),
    };
  } catch (error) {
    if (error instanceof FunAsrError) throw error;
    throw new FunAsrError("MODEL_LOAD_FAILED", "FunASR punctuation assets failed to load", { cause: error });
  }
}

function parseLogits(
  results: ort.InferenceSession.ReturnType,
  expectedFrames: number,
): Int32Array {
  const logits = requireFloatTensor(results.logits, "punctuation logits");
  if (
    logits.dims.length !== 3 ||
    logits.dims[0] !== 1 ||
    logits.dims[1] !== expectedFrames ||
    logits.dims[2] !== PUNCTUATION_CLASSES
  ) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR punctuation logits shape is invalid");
  }
  return argmaxRows(logits.data, expectedFrames, PUNCTUATION_CLASSES);
}

async function inferWindow(
  session: ort.InferenceSession,
  ids: readonly number[],
): Promise<number[]> {
  if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id < 0)) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR punctuation input is invalid");
  }
  const input = new ort.Tensor("int32", Int32Array.from(ids), [1, ids.length]);
  const lengths = new ort.Tensor("int32", Int32Array.of(ids.length), [1]);
  let results: ort.InferenceSession.ReturnType | undefined;
  try {
    results = await session.run({ inputs: input, text_lengths: lengths });
    return Array.from(parseLogits(results, ids.length));
  } catch (error) {
    if (error instanceof FunAsrError) throw error;
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR punctuation ONNX inference failed", { cause: error });
  } finally {
    input.dispose();
    lengths.dispose();
    disposeResults(results);
  }
}

function findSentenceEnd(
  punctuationIds: readonly number[],
  state: WindowState,
  config: FunAsrPunctuationConfig,
): { end: number; punctuationIds: number[] } {
  const output = [...punctuationIds];
  let comma = -1;
  for (let index = output.length - 2; index >= 2; index -= 1) {
    const punctuation = config.punctuationList[output[index]!] ?? "_";
    if (punctuation === "。" || punctuation === "？") return { end: index, punctuationIds: output };
    if (comma < 0 && punctuation === "，") comma = index;
  }
  if (state.words.length > CACHE_LIMIT && comma >= 0) {
    output[comma] = config.sentenceEndId;
    return { end: comma, punctuationIds: output };
  }
  return { end: -1, punctuationIds: output };
}

function formatWindow(
  words: readonly string[],
  punctuationIds: readonly number[],
  punctuationList: readonly string[],
): string {
  let output = "";
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const previous = words[index - 1];
    if (previous !== undefined && isAsciiLeading(word) && isAsciiLeading(previous)) output += " ";
    output += word;
    const punctuation = punctuationList[punctuationIds[index]!] ?? "_";
    if (punctuation !== "_") output += punctuation;
  }
  return output;
}

function isAsciiLeading(word: string): boolean {
  return word !== "" && word.charCodeAt(0) <= 0x7f;
}

function finalizePunctuation(
  text: string,
  punctuationIds: number[],
  sentenceEndId: number,
): string {
  if (text === "") return text;
  if (text.endsWith("，") || text.endsWith("、")) {
    punctuationIds[punctuationIds.length - 1] = sentenceEndId;
    return `${text.slice(0, -1)}。`;
  }
  if (!text.endsWith("。") && !text.endsWith("？")) {
    punctuationIds[punctuationIds.length - 1] = sentenceEndId;
    return `${text}。`;
  }
  return text;
}

async function punctuate(
  session: ort.InferenceSession,
  assets: PunctuatorAssets,
  text: string,
): Promise<{ punctuationIds: number[]; text: string }> {
  const words = codeMixSplitWords(text);
  if (words.length === 0) return { punctuationIds: [], text: "" };
  const wordWindows = splitToMiniSentences(words, SPLIT_SIZE);
  const idWindows = splitToMiniSentences(assets.tokens.tokensToIds(words), SPLIT_SIZE);
  let cache: WindowState = { ids: [], words: [] };
  let assembled = "";
  const punctuationIds: number[] = [];
  for (let index = 0; index < wordWindows.length; index += 1) {
    const state = {
      ids: [...cache.ids, ...idWindows[index]!],
      words: [...cache.words, ...wordWindows[index]!],
    };
    let ids = await inferWindow(session, state.ids);
    let emitted = state;
    if (index < wordWindows.length - 1) {
      const split = findSentenceEnd(ids, state, assets.config);
      cache = { ids: state.ids.slice(split.end + 1), words: state.words.slice(split.end + 1) };
      emitted = { ids: state.ids.slice(0, split.end + 1), words: state.words.slice(0, split.end + 1) };
      ids = split.punctuationIds.slice(0, split.end + 1);
    }
    assembled += formatWindow(emitted.words, ids, assets.config.punctuationList);
    punctuationIds.push(...ids);
  }
  if (punctuationIds.length !== words.length) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR punctuation output does not align");
  }
  return {
    punctuationIds,
    text: finalizePunctuation(assembled, punctuationIds, assets.config.sentenceEndId),
  };
}

export async function loadFunAsrPunctuator(paths: FunAsrPunctuatorPaths): Promise<FunAsrPunctuator> {
  const assets = await readAssets(paths);
  const session = await createSession(paths.modelPath, INPUT_NAMES, OUTPUT_NAMES);
  let closed = false;
  return {
    punctuationList: assets.config.punctuationList,
    async close() {
      if (closed) return;
      closed = true;
      await session.release();
    },
    async punctuate(text) {
      if (closed) throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR punctuator is closed");
      const start = performance.now();
      const result = await punctuate(session, assets, text);
      return { ...result, inferenceMs: performance.now() - start };
    },
  };
}
