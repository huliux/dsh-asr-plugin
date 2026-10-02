import { performance } from "node:perf_hooks";

import type { Pcm16WavReader } from "../audio/wav-reader.js";
import { VadProcessingError } from "./errors.js";
import { mergeSpeechBlocks, splitSpeechRegions } from "./vad-regions.js";
import type { SpeechBlock, SpeechRegion } from "./vad-regions.js";

export const VAD_WINDOW_SAMPLES = 160_000;
export const VAD_STEP_SAMPLES = 32_000;
export const VAD_BATCH_WINDOWS = 6;
export const VAD_OUTPUT_FRAMES = 589;
export const VAD_CLASSES = 7;

const SPEECH_THRESHOLD = 0.8;
const SPEAKER_TURN_THRESHOLD = 0.4;
const TURN_LOOKAHEAD = 8;
const ACCUMULATOR_CAPACITY = 1_024;
const MAX_RAW_BLOCKS = 20_000;

export interface VadInferenceModel {
  infer(input: Float32Array, batchWindows: number): Promise<Float32Array>;
}

export interface BoundedVadMetrics {
  readonly batchCount: number;
  readonly inferenceMs: number;
  readonly maxBatchInputSamples: number;
  readonly maxBatchWindows: number;
  readonly maxPendingFrames: number;
  readonly vadMs: number;
  readonly windowCount: number;
}

export interface BoundedVadResult {
  readonly asrChunks: readonly SpeechRegion[];
  readonly metrics: BoundedVadMetrics;
  readonly speechRegions: readonly SpeechRegion[];
}

interface AggregatedFrame {
  index: number;
  speech: number;
  speakerTurn: number;
}

function inferenceFailure(message: string, cause?: unknown): VadProcessingError {
  return new VadProcessingError(
    "MODEL_INFERENCE_FAILED",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function countWindows(frameCount: number): number {
  if (frameCount === 0) return 0;
  if (frameCount <= VAD_WINDOW_SAMPLES) return 1;
  return Math.ceil((frameCount - VAD_WINDOW_SAMPLES) / VAD_STEP_SAMPLES) + 1;
}

function countFullWindows(frameCount: number): number {
  if (frameCount < VAD_WINDOW_SAMPLES) return 0;
  return Math.floor((frameCount - VAD_WINDOW_SAMPLES) / VAD_STEP_SAMPLES) + 1;
}

function countOutputFrames(frameCount: number): number {
  return Math.round((frameCount * VAD_OUTPUT_FRAMES) / VAD_WINDOW_SAMPLES);
}

function outputStart(windowIndex: number): number {
  return Math.floor(
    (windowIndex * VAD_STEP_SAMPLES * VAD_OUTPUT_FRAMES) / VAD_WINDOW_SAMPLES,
  );
}

async function readWindowBatch(
  reader: Pcm16WavReader,
  inputBuffer: Float32Array,
  firstWindow: number,
  batchWindows: number,
  frameCount: number,
): Promise<Float32Array> {
  const input = inputBuffer.subarray(0, batchWindows * VAD_WINDOW_SAMPLES);
  input.fill(0);
  for (let index = 0; index < batchWindows; index += 1) {
    const startFrame = (firstWindow + index) * VAD_STEP_SAMPLES;
    const endFrame = Math.min(
      startFrame + VAD_WINDOW_SAMPLES,
      frameCount,
    );
    await reader.readFramesInto(
      startFrame,
      endFrame,
      input,
      index * VAD_WINDOW_SAMPLES,
    );
  }
  if (!input.every(Number.isFinite)) {
    throw inferenceFailure("WAV range reader returned invalid VAD samples");
  }
  return input;
}

export class StreamingBoundedVad {
  private readonly accumulator = new FrameAccumulator();
  private readonly builder = new SpeechBlockBuilder();
  private readonly inputBuffer = new Float32Array(VAD_BATCH_WINDOWS * VAD_WINDOW_SAMPLES);
  private readonly smoother = new SpeakerTurnSmoother((frame) => this.builder.push(frame));
  private readonly started = performance.now();
  private batchCount = 0;
  private finished = false;
  private inferenceMs = 0;
  private maxBatchWindows = 0;
  private nextWindow = 0;
  private priorFrameCount = 0;

  constructor(
    private readonly reader: Pcm16WavReader,
    private readonly model: VadInferenceModel,
  ) {}

  get metrics(): BoundedVadMetrics {
    return {
      batchCount: this.batchCount,
      inferenceMs: Math.round(this.inferenceMs),
      maxBatchInputSamples: this.maxBatchWindows * VAD_WINDOW_SAMPLES,
      maxBatchWindows: this.maxBatchWindows,
      maxPendingFrames: this.accumulator.maxPendingFrames,
      vadMs: Math.round(performance.now() - this.started),
      windowCount: this.nextWindow,
    };
  }

  async advance(frameCount: number, final = false): Promise<void> {
    this.assertAdvance(frameCount);
    const target = final ? countWindows(frameCount) : countFullWindows(frameCount);
    const totalFrames = final ? countOutputFrames(frameCount) : Number.MAX_SAFE_INTEGER;
    while (this.nextWindow < target) {
      const batchWindows = Math.min(VAD_BATCH_WINDOWS, target - this.nextWindow);
      await this.processBatch(batchWindows, frameCount, totalFrames, target, final);
    }
    this.priorFrameCount = frameCount;
    if (final) this.finish(totalFrames);
  }

  snapshot(durationMs: number): Pick<BoundedVadResult, "asrChunks" | "speechRegions"> {
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
      throw inferenceFailure("VAD snapshot duration is invalid");
    }
    const speechRegions = mergeSpeechBlocks(
      this.builder.blocks.map((block) => ({ ...block })),
      durationMs,
    );
    return { speechRegions, asrChunks: splitSpeechRegions(speechRegions) };
  }

  private assertAdvance(frameCount: number): void {
    if (
      this.finished ||
      !Number.isSafeInteger(frameCount) ||
      frameCount < this.priorFrameCount ||
      frameCount > this.reader.metadata.frameCount
    ) throw inferenceFailure("VAD incremental frame range is invalid");
  }

  private async processBatch(
    batchWindows: number,
    frameCount: number,
    totalFrames: number,
    target: number,
    final: boolean,
  ): Promise<void> {
    const input = await readWindowBatch(
      this.reader,
      this.inputBuffer,
      this.nextWindow,
      batchWindows,
      frameCount,
    );
    const inference = await inferBatch(this.model, input, batchWindows);
    this.inferenceMs += inference.elapsedMs;
    this.batchCount += 1;
    this.maxBatchWindows = Math.max(this.maxBatchWindows, batchWindows);
    for (let batchWindow = 0; batchWindow < batchWindows; batchWindow += 1) {
      const globalWindow = this.nextWindow + batchWindow;
      addWindow(this.accumulator, inference.logits, batchWindow, globalWindow, totalFrames);
      const following = globalWindow + 1;
      const drainEnd = final && following === target ? totalFrames : outputStart(following);
      this.accumulator.drainBefore(drainEnd, (frame) => this.smoother.push(frame));
    }
    this.nextWindow += batchWindows;
  }

  private finish(totalFrames: number): void {
    this.accumulator.drainBefore(totalFrames, (frame) => this.smoother.push(frame));
    this.smoother.finish();
    this.builder.finish();
    this.finished = true;
  }
}

function assertLogits(logits: Float32Array, batchWindows: number): void {
  const expected = batchWindows * VAD_OUTPUT_FRAMES * VAD_CLASSES;
  if (!(logits instanceof Float32Array) || logits.length !== expected) {
    throw inferenceFailure("VAD model returned an invalid output shape");
  }
  if (!logits.every(Number.isFinite)) {
    throw inferenceFailure("VAD model returned non-finite logits");
  }
}

async function inferBatch(
  model: VadInferenceModel,
  input: Float32Array,
  batchWindows: number,
): Promise<{ elapsedMs: number; logits: Float32Array }> {
  const started = performance.now();
  try {
    const logits = await model.infer(input, batchWindows);
    assertLogits(logits, batchWindows);
    return { elapsedMs: performance.now() - started, logits };
  } catch (error) {
    if (error instanceof VadProcessingError) throw error;
    throw inferenceFailure("VAD model inference failed", error);
  }
}

function hamming(frameIndex: number): number {
  return (
    0.54 -
    0.46 * Math.cos((2 * Math.PI * frameIndex) / (VAD_OUTPUT_FRAMES - 1))
  );
}

function labelAt(logits: Float32Array, frameOffset: number): number {
  let label = 0;
  let maximum = logits[frameOffset]!;
  for (let index = 1; index < VAD_CLASSES; index += 1) {
    const value = logits[frameOffset + index]!;
    if (value > maximum) {
      maximum = value;
      label = index;
    }
  }
  return label;
}

class FrameAccumulator {
  private readonly speech = new Float64Array(ACCUMULATOR_CAPACITY);
  private readonly speakerTurns = new Float64Array(ACCUMULATOR_CAPACITY);
  private readonly tags = new Int32Array(ACCUMULATOR_CAPACITY).fill(-1);
  private readonly weights = new Float64Array(ACCUMULATOR_CAPACITY);
  private nextFrame = 0;
  maxPendingFrames = 0;

  add(frameIndex: number, speech: number, speakerTurn: number, weight: number): void {
    const span = frameIndex - this.nextFrame + 1;
    if (span < 1 || span > ACCUMULATOR_CAPACITY) {
      throw inferenceFailure("VAD aggregation exceeded its bounded frame window");
    }
    const slot = frameIndex % ACCUMULATOR_CAPACITY;
    if (this.tags[slot] !== frameIndex) {
      if (this.tags[slot] !== -1) throw inferenceFailure("VAD frame ring collision");
      this.tags[slot] = frameIndex;
      this.speech[slot] = 0;
      this.speakerTurns[slot] = 0;
      this.weights[slot] = 0;
    }
    this.speech[slot] = this.speech[slot]! + speech * weight;
    this.speakerTurns[slot] = this.speakerTurns[slot]! + speakerTurn * weight;
    this.weights[slot] = this.weights[slot]! + weight;
    this.maxPendingFrames = Math.max(this.maxPendingFrames, span);
  }

  drainBefore(endFrame: number, sink: (frame: AggregatedFrame) => void): void {
    while (this.nextFrame < endFrame) {
      const slot = this.nextFrame % ACCUMULATOR_CAPACITY;
      const weight = this.tags[slot] === this.nextFrame ? this.weights[slot]! : 0;
      sink({
        index: this.nextFrame,
        speech: weight > 0 ? this.speech[slot]! / weight : 0,
        speakerTurn: weight > 0 ? this.speakerTurns[slot]! / weight : 0,
      });
      this.tags[slot] = -1;
      this.nextFrame += 1;
    }
  }
}

class SpeakerTurnSmoother {
  private readonly frames: AggregatedFrame[] = [];

  constructor(private readonly sink: (frame: AggregatedFrame) => void) {}

  push(frame: AggregatedFrame): void {
    this.frames.push(frame);
    if (this.frames.length >= TURN_LOOKAHEAD) this.emitFirst();
  }

  finish(): void {
    while (this.frames.length > 0) this.emitFirst();
  }

  private emitFirst(): void {
    const current = this.frames[0]!;
    const lookahead = Math.min(TURN_LOOKAHEAD, this.frames.length);
    if (current.speakerTurn > 0) {
      let sum = 0;
      for (let index = 0; index < lookahead; index += 1) {
        sum += this.frames[index]!.speakerTurn;
      }
      if (sum > current.speakerTurn) {
        current.speakerTurn = sum;
        for (let index = 1; index < lookahead; index += 1) {
          this.frames[index]!.speakerTurn = 0;
        }
      }
    }
    this.sink(current);
    this.frames.shift();
  }
}

function frameStartMs(frameIndex: number): number {
  return Math.floor((frameIndex * 10_000) / VAD_OUTPUT_FRAMES);
}

function frameEndMs(frameIndex: number): number {
  return Math.ceil((frameIndex * 10_000) / VAD_OUTPUT_FRAMES);
}

class SpeechBlockBuilder {
  private readonly frames: AggregatedFrame[] = [];
  private readonly priorTurns: number[] = [];
  private speaking = false;
  readonly blocks: SpeechBlock[] = [];

  push(frame: AggregatedFrame): void {
    this.frames.push(frame);
    if (this.frames.length >= 3) this.emitFirst();
  }

  finish(): void {
    while (this.frames.length > 0) this.emitFirst();
  }

  private nearbySpeakerTurn(): number {
    return Math.max(
      0,
      ...this.priorTurns,
      ...this.frames.slice(0, 3).map((frame) => frame.speakerTurn),
    );
  }

  private startBlock(frame: AggregatedFrame): void {
    if (this.blocks.length >= MAX_RAW_BLOCKS) {
      throw new VadProcessingError("RESOURCE_LIMIT", "Too many VAD speech blocks");
    }
    const startMs = frameStartMs(frame.index);
    this.blocks.push({ startMs, endMs: startMs, speakerTurn: this.nearbySpeakerTurn() });
  }

  private emitFirst(): void {
    const current = this.frames[0]!;
    if (!this.speaking && current.speech > SPEECH_THRESHOLD) {
      this.speaking = true;
      this.startBlock(current);
    } else if (this.speaking && current.speakerTurn > SPEAKER_TURN_THRESHOLD) {
      this.speaking = (this.frames[1]?.speech ?? 0) > SPEECH_THRESHOLD;
      if (this.speaking) this.startBlock(current);
    } else if (this.speaking && current.speech < SPEECH_THRESHOLD) {
      this.speaking = false;
    } else if (this.speaking) {
      const last = this.blocks.at(-1)!;
      this.blocks[this.blocks.length - 1] = { ...last, endMs: frameEndMs(current.index) };
    }
    this.priorTurns.push(current.speakerTurn);
    if (this.priorTurns.length > 3) this.priorTurns.shift();
    this.frames.shift();
  }
}

function addWindow(
  accumulator: FrameAccumulator,
  logits: Float32Array,
  batchWindow: number,
  globalWindow: number,
  totalOutputFrames: number,
): void {
  let currentSpeaker = 0;
  const startFrame = outputStart(globalWindow);
  for (let frame = 0; frame < VAD_OUTPUT_FRAMES; frame += 1) {
    const offset = (batchWindow * VAD_OUTPUT_FRAMES + frame) * VAD_CLASSES;
    const label = labelAt(logits, offset);
    const speakerTurn =
      frame > 0 && currentSpeaker !== 0 && label !== currentSpeaker && label > 0 && label < 4
        ? 1
        : 0;
    if (label > 0 && label < 4) currentSpeaker = label;
    const outputFrame = startFrame + frame;
    if (outputFrame < totalOutputFrames) {
      accumulator.add(outputFrame, Number(label > 0), speakerTurn, hamming(frame));
    }
  }
}

export async function runBoundedVad(
  reader: Pcm16WavReader,
  model: VadInferenceModel,
): Promise<BoundedVadResult> {
  const streaming = new StreamingBoundedVad(reader, model);
  await streaming.advance(reader.metadata.frameCount, true);
  const result = streaming.snapshot(reader.metadata.durationMs);
  return {
    ...result,
    metrics: streaming.metrics,
  };
}
