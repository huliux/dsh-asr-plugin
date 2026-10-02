import { readFile } from "node:fs/promises";
import * as ort from "onnxruntime-node";

import { loadFbank } from "../../native/fbank.js";
import type { Fbank } from "../../native/fbank.js";
import {
  parseFunAsrCmvn,
  parseFunAsrFrontendConfig,
  parseTokenList,
} from "./config.js";
import type { FunAsrFrontendConfig } from "./config.js";
import { FunAsrError } from "./errors.js";
import { applyCmvn, applyLfr } from "./frontend.js";
import type { FunAsrCmvn } from "./frontend.js";
import { argmaxRows, createSession, disposeResults, requireFloatTensor, requireInt32Tensor } from "./onnx.js";
import type { FunAsrChunkDraft, FunAsrRecognizer } from "./pipeline.js";
import { sentencePostprocess, sentencePostprocessWithTimestamps, TokenIdConverter } from "./text.js";
import { decodeBiCifTokenTimestamps } from "./timestamps.js";

const INPUT_NAMES = ["speech", "speech_lengths"] as const;
const OUTPUT_NAMES = ["logits", "token_num", "us_alphas", "us_cif_peak"] as const;
const ASR_VOCAB_SIZE = 8_404;

export interface FunAsrRecognizerPaths {
  readonly cmvnPath: string;
  readonly configPath: string;
  readonly fbankPath: string;
  readonly modelPath: string;
  readonly tokensPath: string;
}

interface RecognizerAssets {
  readonly cmvn: FunAsrCmvn;
  readonly config: FunAsrFrontendConfig;
  readonly fbank: Fbank;
  readonly tokens: TokenIdConverter;
}

interface AsrOutputs {
  readonly alphas: Float32Array | null;
  readonly peaks: Float32Array;
  readonly tokens: string[];
}

async function readAssets(paths: FunAsrRecognizerPaths): Promise<RecognizerAssets> {
  try {
    const [config, cmvn, tokenJson] = await Promise.all([
      readFile(paths.configPath, "utf8"),
      readFile(paths.cmvnPath, "utf8"),
      readFile(paths.tokensPath, "utf8"),
    ]);
    const tokenList = parseTokenList(tokenJson);
    if (tokenList.length !== ASR_VOCAB_SIZE) {
      throw new FunAsrError("ASSET_MISMATCH", "FunASR ASR vocabulary size drifted");
    }
    return {
      cmvn: parseFunAsrCmvn(cmvn),
      config: parseFunAsrFrontendConfig(config),
      fbank: loadFbank(paths.fbankPath),
      tokens: new TokenIdConverter(tokenList),
    };
  } catch (error) {
    if (error instanceof FunAsrError) throw error;
    throw new FunAsrError("MODEL_LOAD_FAILED", "FunASR recognizer assets failed to load", { cause: error });
  }
}

function validateLogits(value: ort.OnnxValue | undefined): ort.TypedTensor<"float32"> {
  const tensor = requireFloatTensor(value, "ASR logits");
  if (
    tensor.dims.length !== 3 ||
    tensor.dims[0] !== 1 ||
    tensor.dims[2] !== ASR_VOCAB_SIZE ||
    tensor.data.length !== tensor.dims[1]! * ASR_VOCAB_SIZE
  ) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR ASR logits shape is invalid");
  }
  return tensor;
}

function copyTimingTensor(value: ort.OnnxValue | undefined, name: string): Float32Array {
  const tensor = requireFloatTensor(value, name);
  if (tensor.dims.length < 1 || tensor.data.length === 0) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", `FunASR ${name} shape is invalid`);
  }
  return new Float32Array(tensor.data);
}

function parseAsrOutputs(
  results: ort.InferenceSession.ReturnType,
  assets: RecognizerAssets,
): AsrOutputs {
  const logits = validateLogits(results.logits);
  const tokenNum = requireInt32Tensor(results.token_num, "ASR token count");
  const frames = logits.dims[1]!;
  const count = Number(tokenNum.data[0]) - assets.config.predictorBias;
  if (!Number.isSafeInteger(count) || count < 0 || count > frames) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR ASR token count is invalid");
  }
  const ids = Array.from(argmaxRows(logits.data, frames, ASR_VOCAB_SIZE))
    .filter((id) => id !== 0 && id !== 2)
    .slice(0, count);
  return {
    alphas: results.us_alphas === undefined ? null : copyTimingTensor(results.us_alphas, "ASR alphas"),
    peaks: copyTimingTensor(results.us_cif_peak, "ASR CIF peaks"),
    tokens: assets.tokens.idsToTokens(ids),
  };
}

async function inferAsr(
  session: ort.InferenceSession,
  input: Float32Array,
  frames: number,
  inputSize: number,
  assets: RecognizerAssets,
): Promise<AsrOutputs> {
  const speech = new ort.Tensor("float32", input, [1, frames, inputSize]);
  const lengths = new ort.Tensor("int32", Int32Array.of(frames), [1]);
  let results: ort.InferenceSession.ReturnType | undefined;
  try {
    results = await session.run({ speech, speech_lengths: lengths });
    return parseAsrOutputs(results, assets);
  } catch (error) {
    if (error instanceof FunAsrError) throw error;
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR ASR ONNX inference failed", { cause: error });
  } finally {
    speech.dispose();
    lengths.dispose();
    disposeResults(results);
  }
}

function buildDraft(
  output: AsrOutputs,
  featureFrames: number,
  frontendMs: number,
  inferenceMs: number,
): FunAsrChunkDraft {
  const plain = sentencePostprocess(output.tokens);
  const decoded = decodeBiCifTokenTimestamps(output.tokens, output.peaks, output.alphas);
  const timestamped = decoded.length === output.tokens.length
    ? sentencePostprocessWithTimestamps(output.tokens, decoded)
    : null;
  return {
    featureFrames,
    frontendMs,
    inferenceMs,
    puncInput: timestamped?.sentence ?? plain.sentence,
    rawText: plain.sentence,
    timestampsMs: timestamped?.timestamps ?? null,
    tokenCount: timestamped?.tokens.length ?? plain.tokens.length,
    tokens: timestamped?.tokens ?? plain.tokens,
  };
}

async function recognize(
  session: ort.InferenceSession,
  assets: RecognizerAssets,
  samples: Float32Array,
): Promise<FunAsrChunkDraft> {
  const frontendStart = performance.now();
  const mel = assets.fbank.extract(samples);
  const lfr = applyLfr(mel.data, mel.dims[0], mel.dims[1], assets.config.lfrM, assets.config.lfrN);
  if (lfr.frames === 0 || lfr.data.length / lfr.frames !== assets.config.inputSize) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR frontend produced invalid dimensions");
  }
  const normalized = applyCmvn(lfr.data, lfr.frames, assets.config.inputSize, assets.cmvn);
  const frontendMs = performance.now() - frontendStart;
  const inferenceStart = performance.now();
  const output = await inferAsr(session, normalized, lfr.frames, assets.config.inputSize, assets);
  return buildDraft(output, lfr.frames, frontendMs, performance.now() - inferenceStart);
}

export async function loadFunAsrRecognizer(paths: FunAsrRecognizerPaths): Promise<FunAsrRecognizer> {
  const assets = await readAssets(paths);
  const session = await createSession(paths.modelPath, INPUT_NAMES, OUTPUT_NAMES);
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      await session.release();
    },
    async recognize(samples) {
      if (closed) throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR recognizer is closed");
      return recognize(session, assets, samples);
    },
  };
}
