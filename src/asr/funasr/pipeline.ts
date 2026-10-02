import type { Pcm16WavReader } from "../../audio/wav-reader.js";
import type { SpeechRegion } from "../vad-regions.js";
import { baseBlocks, baseTokenUnits } from "./base-segmentation.js";
import { FunAsrError } from "./errors.js";
import { buildSentenceBlocks, buildTokenUnits } from "./text.js";
import type { FunAsrTokenUnit } from "./text.js";

const SAMPLE_RATE = 16_000;
const MAX_CHUNK_MS = 60_000;
const MAX_CHUNKS = 20_000;
const MAX_BLOCKS = 20_000;
const TIMESTAMP_END_TOLERANCE_MS = 40;

export interface FunAsrChunkDraft {
  readonly featureFrames: number;
  readonly frontendMs: number;
  readonly inferenceMs: number;
  readonly puncInput: string;
  readonly rawText: string;
  readonly timestampsMs: readonly (readonly [number, number])[] | null;
  readonly tokenCount: number;
  readonly tokens: readonly string[];
}

export interface FunAsrRecognizer {
  close(): Promise<void>;
  recognize(samples: Float32Array): Promise<FunAsrChunkDraft>;
}

export interface FunAsrPunctuationResult {
  readonly inferenceMs: number;
  readonly punctuationIds: readonly number[];
  readonly text: string;
}

export interface FunAsrPunctuator {
  readonly punctuationList: readonly string[];
  close(): Promise<void>;
  punctuate(text: string): Promise<FunAsrPunctuationResult>;
}

export interface FunAsrRuntimeFactory {
  loadPunctuator(): Promise<FunAsrPunctuator>;
  loadRecognizer(): Promise<FunAsrRecognizer>;
}

export interface LoadedFunAsrRuntime {
  readonly recognizer: FunAsrRecognizer;
  readonly mode?: "base" | "enhanced";
  readonly punctuator?: FunAsrPunctuator;
}

export interface FunAsrBlock {
  readonly endMs: number;
  readonly seq: number;
  readonly startMs: number;
  readonly text: string;
}

export interface FunAsrMetrics {
  readonly asrInferenceMs: number;
  readonly chunkCount: number;
  readonly featureFrames: number;
  readonly frontendMs: number;
  readonly punctuationInferenceMs: number;
  readonly tokenCount: number;
}

export interface FunAsrResult {
  readonly blocks: readonly FunAsrBlock[];
  readonly emptyReason: "silent" | "too_short" | null;
  readonly metrics: FunAsrMetrics;
}

export interface FunAsrDraftResult {
  readonly emptyReason: "silent" | "too_short" | null;
  readonly metrics: FunAsrMetrics;
  readonly units: readonly FunAsrTokenUnit[];
}

interface RecognizedChunk {
  readonly draft: FunAsrChunkDraft;
  readonly region: SpeechRegion;
}

interface RecognitionMetrics {
  asrInferenceMs: number;
  chunkCount: number;
  featureFrames: number;
  frontendMs: number;
  tokenCount: number;
}

interface RecognitionResult {
  readonly chunks: readonly RecognizedChunk[];
  readonly metrics: RecognitionMetrics;
}

function inferenceFailure(message: string, cause?: unknown): FunAsrError {
  return new FunAsrError(
    "MODEL_INFERENCE_FAILED",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function normalizeFailure(error: unknown, message: string): FunAsrError {
  return error instanceof FunAsrError ? error : inferenceFailure(message, error);
}

function assertChunks(chunks: readonly SpeechRegion[], durationMs: number): void {
  if (chunks.length > MAX_CHUNKS) throw new FunAsrError("RESOURCE_LIMIT", "Too many ASR chunks");
  let previousEnd = 0;
  for (const chunk of chunks) {
    if (
      !Number.isSafeInteger(chunk.startMs) ||
      !Number.isSafeInteger(chunk.endMs) ||
      chunk.startMs < previousEnd ||
      chunk.startMs < 0 ||
      chunk.endMs <= chunk.startMs ||
      chunk.endMs > durationMs ||
      chunk.endMs - chunk.startMs > MAX_CHUNK_MS
    ) {
      throw inferenceFailure("Invalid FunASR speech chunk");
    }
    previousEnd = chunk.endMs;
  }
}

function validTimestamps(
  timestamps: readonly (readonly [number, number])[],
  durationMs: number,
): boolean {
  let previousEnd = 0;
  for (const [start, end] of timestamps) {
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < previousEnd ||
      start >= durationMs ||
      end <= start ||
      end > durationMs + TIMESTAMP_END_TOLERANCE_MS
    ) return false;
    previousEnd = end;
  }
  return true;
}

function assertDraft(draft: FunAsrChunkDraft, region: SpeechRegion): boolean {
  const times = [draft.frontendMs, draft.inferenceMs];
  const durationMs = region.endMs - region.startMs;
  const empty = draft.tokenCount === 0;
  if (
    !times.every((value) => Number.isFinite(value) && value >= 0) ||
    !Number.isSafeInteger(draft.featureFrames) ||
    !Number.isSafeInteger(draft.tokenCount) ||
    draft.featureFrames <= 0 ||
    draft.tokenCount < 0 ||
    draft.tokens.length !== draft.tokenCount ||
    draft.tokens.some((token) => token === "") ||
    (empty
      ? draft.rawText.trim() !== "" || draft.puncInput.trim() !== ""
      : draft.rawText.trim() === "" || draft.puncInput.trim() === "") ||
    (draft.timestampsMs !== null && (
      draft.timestampsMs.length !== draft.tokens.length ||
      !validTimestamps(draft.timestampsMs, durationMs)
    ))
  ) {
    throw inferenceFailure("FunASR returned an empty or invalid speech result");
  }
  return empty;
}

function frameRange(reader: Pcm16WavReader, region: SpeechRegion): [number, number] {
  const start = Math.floor((region.startMs * SAMPLE_RATE) / 1_000);
  const end = Math.min(reader.metadata.frameCount, Math.ceil((region.endMs * SAMPLE_RATE) / 1_000));
  if (end <= start || end - start > SAMPLE_RATE * 60) {
    throw inferenceFailure("Invalid FunASR PCM range");
  }
  return [start, end];
}

async function closeRecognizer(
  recognizer: FunAsrRecognizer,
  failure: FunAsrError | null,
): Promise<FunAsrError | null> {
  try {
    await recognizer.close();
    return failure;
  } catch (error) {
    return failure ?? inferenceFailure("FunASR recognizer failed to close", error);
  }
}

async function recognizeChunks(
  reader: Pcm16WavReader,
  chunks: readonly SpeechRegion[],
  factory: FunAsrRuntimeFactory,
): Promise<RecognitionResult> {
  let recognizer: FunAsrRecognizer;
  try {
    recognizer = await factory.loadRecognizer();
  } catch (error) {
    throw error instanceof FunAsrError
      ? error
      : new FunAsrError("MODEL_LOAD_FAILED", "FunASR recognizer failed to load", { cause: error });
  }
  let result: RecognitionResult | undefined;
  let failure: FunAsrError | null = null;
  try {
    result = await recognizeWithLoadedRuntime(reader, chunks, recognizer);
  } catch (error) {
    failure = normalizeFailure(error, "FunASR recognition failed");
  }
  failure = await closeRecognizer(recognizer, failure);
  if (failure !== null) throw failure;
  return result!;
}

async function recognizeWithLoadedRuntime(
  reader: Pcm16WavReader,
  chunks: readonly SpeechRegion[],
  recognizer: FunAsrRecognizer,
): Promise<RecognitionResult> {
  const output: RecognizedChunk[] = [];
  const metrics: RecognitionMetrics = {
    asrInferenceMs: 0,
    chunkCount: 0,
    featureFrames: 0,
    frontendMs: 0,
    tokenCount: 0,
  };
  try {
    for (const region of chunks) {
      const [start, end] = frameRange(reader, region);
      const draft = await recognizer.recognize(await reader.readFrames(start, end));
      const empty = assertDraft(draft, region);
      metrics.asrInferenceMs += draft.inferenceMs;
      metrics.chunkCount += 1;
      metrics.featureFrames += draft.featureFrames;
      metrics.frontendMs += draft.frontendMs;
      metrics.tokenCount += draft.tokenCount;
      if (!empty) output.push({ draft, region });
    }
  } catch (error) {
    throw normalizeFailure(error, "FunASR recognition failed");
  }
  return { chunks: output, metrics };
}

async function closePunctuator(
  punctuator: FunAsrPunctuator,
  failure: FunAsrError | null,
): Promise<FunAsrError | null> {
  try {
    await punctuator.close();
    return failure;
  } catch (error) {
    return failure ?? inferenceFailure("FunASR punctuator failed to close", error);
  }
}

function chunkBlocks(
  chunk: RecognizedChunk,
  result: FunAsrPunctuationResult,
  punctuationList: readonly string[],
): Omit<FunAsrBlock, "seq">[] {
  assertPunctuation(chunk, result, punctuationList);
  if (chunk.draft.timestampsMs === null) {
    return [{ ...chunk.region, text: result.text.trim() }];
  }
  return buildSentenceBlocks(
    chunk.draft.tokens,
    chunk.draft.timestampsMs,
    result.punctuationIds,
    punctuationList,
    chunk.region.startMs,
    chunk.region.endMs,
  );
}

function assertPunctuation(
  chunk: RecognizedChunk,
  result: FunAsrPunctuationResult,
  punctuationList: readonly string[],
): void {
  if (result.text.trim() === "" || !Number.isFinite(result.inferenceMs) || result.inferenceMs < 0) {
    throw inferenceFailure("FunASR punctuation returned an invalid result");
  }
  if (
    result.punctuationIds.length !== chunk.draft.tokens.length ||
    result.punctuationIds.some((id) =>
      !Number.isSafeInteger(id) || id < 0 || id >= punctuationList.length)
  ) throw inferenceFailure("FunASR punctuation IDs do not align");
}

function chunkTokenUnits(
  chunk: RecognizedChunk,
  result: FunAsrPunctuationResult,
  punctuationList: readonly string[],
): FunAsrTokenUnit[] {
  assertPunctuation(chunk, result, punctuationList);
  if (chunk.draft.timestampsMs === null) {
    throw inferenceFailure("FunASR token timestamps are unavailable for recording drafts");
  }
  return buildTokenUnits(
    chunk.draft.tokens,
    chunk.draft.timestampsMs,
    result.punctuationIds,
    punctuationList,
    chunk.region.startMs,
    chunk.region.endMs,
  );
}

async function punctuateChunks(
  chunks: readonly RecognizedChunk[],
  factory: FunAsrRuntimeFactory,
): Promise<{ blocks: FunAsrBlock[]; inferenceMs: number }> {
  let punctuator: FunAsrPunctuator;
  try {
    punctuator = await factory.loadPunctuator();
  } catch (error) {
    throw error instanceof FunAsrError
      ? error
      : new FunAsrError("MODEL_LOAD_FAILED", "FunASR punctuator failed to load", { cause: error });
  }
  let result: { blocks: FunAsrBlock[]; inferenceMs: number } | undefined;
  let failure: FunAsrError | null = null;
  try {
    result = await punctuateWithLoadedRuntime(chunks, punctuator);
  } catch (error) {
    failure = normalizeFailure(error, "FunASR punctuation failed");
  }
  failure = await closePunctuator(punctuator, failure);
  if (failure !== null) throw failure;
  return result!;
}

async function punctuateWithLoadedRuntime(
  chunks: readonly RecognizedChunk[],
  punctuator: FunAsrPunctuator,
): Promise<{ blocks: FunAsrBlock[]; inferenceMs: number }> {
  const blocks: FunAsrBlock[] = [];
  let inferenceMs = 0;
  try {
    for (const chunk of chunks) {
      const result = await punctuator.punctuate(chunk.draft.puncInput);
      inferenceMs += result.inferenceMs;
      for (const block of chunkBlocks(chunk, result, punctuator.punctuationList)) {
        blocks.push({ ...block, seq: blocks.length });
        if (blocks.length > MAX_BLOCKS) {
          throw new FunAsrError("RESOURCE_LIMIT", "Too many ASR blocks");
        }
      }
    }
  } catch (error) {
    throw normalizeFailure(error, "FunASR punctuation failed");
  }
  return { blocks, inferenceMs };
}

async function punctuateDraftWithLoadedRuntime(
  chunks: readonly RecognizedChunk[],
  punctuator: FunAsrPunctuator,
): Promise<{ inferenceMs: number; units: FunAsrTokenUnit[] }> {
  const units: FunAsrTokenUnit[] = [];
  let inferenceMs = 0;
  try {
    for (const chunk of chunks) {
      const result = await punctuator.punctuate(chunk.draft.puncInput);
      inferenceMs += result.inferenceMs;
      units.push(...chunkTokenUnits(chunk, result, punctuator.punctuationList));
      if (units.length > MAX_BLOCKS) throw new FunAsrError("RESOURCE_LIMIT", "Too many ASR tokens");
    }
  } catch (error) {
    throw normalizeFailure(error, "FunASR draft punctuation failed");
  }
  return { inferenceMs, units };
}

function requirePunctuator(runtime: LoadedFunAsrRuntime): FunAsrPunctuator {
  if (!runtime.punctuator) {
    throw new FunAsrError("MODEL_LOAD_FAILED", "Enhanced mode requires punctuation");
  }
  return runtime.punctuator;
}

function emptyMetrics(): FunAsrMetrics {
  return {
    asrInferenceMs: 0,
    chunkCount: 0,
    featureFrames: 0,
    frontendMs: 0,
    punctuationInferenceMs: 0,
    tokenCount: 0,
  };
}

export async function runFunAsr(
  reader: Pcm16WavReader,
  chunks: readonly SpeechRegion[],
  factory: FunAsrRuntimeFactory,
  mode: "base" | "enhanced" = "enhanced",
): Promise<FunAsrResult> {
  assertChunks(chunks, reader.metadata.durationMs);
  if (chunks.length === 0) return { blocks: [], emptyReason: "silent", metrics: emptyMetrics() };
  const recognized = await recognizeChunks(reader, chunks, factory);
  if (recognized.chunks.length === 0) {
    return {
      blocks: [],
      emptyReason: "too_short",
      metrics: { ...recognized.metrics, punctuationInferenceMs: 0 },
    };
  }
  const punctuated = mode === "base"
    ? { blocks: baseBlocks(recognized.chunks), inferenceMs: 0 }
    : await punctuateChunks(recognized.chunks, factory);
  if (punctuated.blocks.length === 0) throw inferenceFailure("FunASR produced no sentence blocks");
  return {
    blocks: punctuated.blocks,
    emptyReason: null,
    metrics: {
      asrInferenceMs: recognized.metrics.asrInferenceMs,
      chunkCount: recognized.metrics.chunkCount,
      featureFrames: recognized.metrics.featureFrames,
      frontendMs: recognized.metrics.frontendMs,
      punctuationInferenceMs: punctuated.inferenceMs,
      tokenCount: recognized.metrics.tokenCount,
    },
  };
}

export async function runFunAsrWithLoadedRuntime(
  reader: Pcm16WavReader,
  chunks: readonly SpeechRegion[],
  runtime: LoadedFunAsrRuntime,
): Promise<FunAsrResult> {
  assertChunks(chunks, reader.metadata.durationMs);
  if (chunks.length === 0) return { blocks: [], emptyReason: "silent", metrics: emptyMetrics() };
  const recognized = await recognizeWithLoadedRuntime(reader, chunks, runtime.recognizer);
  if (recognized.chunks.length === 0) {
    return {
      blocks: [],
      emptyReason: "too_short",
      metrics: { ...recognized.metrics, punctuationInferenceMs: 0 },
    };
  }
  const punctuated = runtime.mode === "base"
    ? { blocks: baseBlocks(recognized.chunks), inferenceMs: 0 }
    : await punctuateWithLoadedRuntime(recognized.chunks, requirePunctuator(runtime));
  if (punctuated.blocks.length === 0) throw inferenceFailure("FunASR produced no sentence blocks");
  return {
    blocks: punctuated.blocks,
    emptyReason: null,
    metrics: {
      asrInferenceMs: recognized.metrics.asrInferenceMs,
      chunkCount: recognized.metrics.chunkCount,
      featureFrames: recognized.metrics.featureFrames,
      frontendMs: recognized.metrics.frontendMs,
      punctuationInferenceMs: punctuated.inferenceMs,
      tokenCount: recognized.metrics.tokenCount,
    },
  };
}

export async function runFunAsrDraftWithLoadedRuntime(
  reader: Pcm16WavReader,
  chunks: readonly SpeechRegion[],
  runtime: LoadedFunAsrRuntime,
): Promise<FunAsrDraftResult> {
  assertChunks(chunks, reader.metadata.durationMs);
  if (chunks.length === 0) return { units: [], emptyReason: "silent", metrics: emptyMetrics() };
  const recognized = await recognizeWithLoadedRuntime(reader, chunks, runtime.recognizer);
  if (recognized.chunks.length === 0) {
    return {
      units: [],
      emptyReason: "too_short",
      metrics: { ...recognized.metrics, punctuationInferenceMs: 0 },
    };
  }
  const punctuated = runtime.mode === "base"
    ? { units: baseTokenUnits(recognized.chunks), inferenceMs: 0 }
    : await punctuateDraftWithLoadedRuntime(recognized.chunks, requirePunctuator(runtime));
  if (punctuated.units.length === 0) throw inferenceFailure("FunASR produced no token units");
  return {
    units: punctuated.units,
    emptyReason: null,
    metrics: {
      asrInferenceMs: recognized.metrics.asrInferenceMs,
      chunkCount: recognized.metrics.chunkCount,
      featureFrames: recognized.metrics.featureFrames,
      frontendMs: recognized.metrics.frontendMs,
      punctuationInferenceMs: punctuated.inferenceMs,
      tokenCount: recognized.metrics.tokenCount,
    },
  };
}
