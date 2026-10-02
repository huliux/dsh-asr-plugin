import type { FunAsrBlock, FunAsrResult } from "../asr/funasr/pipeline.js";
import type { SpeechRegion } from "../asr/vad-regions.js";
import type { ClosedRecordingChunks } from "../audio/closed-recording-chunks.js";
import {
  RecordingTimelineChangedError,
  RecordingTimelineReader,
} from "../audio/recording-timeline-reader.js";
import type { RecordingTimeline } from "../audio/recording-timeline.js";
import { PCM_SAMPLE_RATE, type Pcm16WavReader } from "../audio/wav-reader.js";
import {
  MIN_EMBEDDING_MS,
  type MeetingDiarizationResult,
  type SpeakerEmbeddingModel,
} from "../diarization/meeting-diarizer.js";
import { planEmbeddingWindows, type EmbeddingWindow } from "../diarization/windows.js";
import type { RecordingFinalCache } from "./final-cache.js";
import { recordingCacheKey } from "./final-cache.js";
import { stableVadPrefix } from "./stable-vad-prefix.js";

const MAX_FINAL_BLOCKS = 20_000;
const TIMELINE_SETTLE_FRAMES = 20 * PCM_SAMPLE_RATE;

export interface RecordingIncrementalVad {
  advance(frameCount: number, final?: boolean): Promise<void>;
  snapshot(durationMs: number): {
    readonly asrChunks: readonly SpeechRegion[];
    readonly speechRegions: readonly SpeechRegion[];
  };
}

export interface RecordingAuthoritativeKernels {
  readonly embeddingModel: SpeakerEmbeddingModel;
  createVad(reader: Pcm16WavReader): RecordingIncrementalVad;
  transcribe(reader: Pcm16WavReader, chunks: readonly SpeechRegion[]): Promise<FunAsrResult>;
  diarize(
    reader: Pcm16WavReader,
    blocks: readonly FunAsrBlock[],
    speechRegions: readonly SpeechRegion[],
    cachedEmbeddingModel: SpeakerEmbeddingModel,
  ): Promise<MeetingDiarizationResult>;
}

export interface RecordingAuthoritativeEngineOptions {
  readonly cache: RecordingFinalCache;
  readonly chunks: ClosedRecordingChunks;
  readonly engineFingerprint: string;
  readonly kernels: RecordingAuthoritativeKernels;
}

export interface RecordingAuthoritativeResult {
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly durationMs: number;
  readonly resultReason: "silent" | "too_short" | "unknown_speaker_segments" | null;
  readonly resultStatus: "completed" | "empty" | "partial";
  readonly segments: readonly {
    readonly seq: number;
    readonly startMs: number;
    readonly endMs: number;
    readonly speakerLabel: string;
    readonly text: string;
  }[];
}

interface CachedAsr {
  readonly cacheKey: string;
  readonly blocks: readonly FunAsrBlock[];
}

interface CacheCounts {
  hits: number;
  misses: number;
}

type CachedEmbedding = Float32Array | { readonly failure: unknown };

export class RecordingAuthoritativeError extends Error {
  readonly code = "INTERNAL_ERROR" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecordingAuthoritativeError";
  }
}

function timeKey(value: { readonly startMs: number; readonly endMs: number }): string {
  return `${value.startMs}:${value.endMs}`;
}

function frameRange(
  reader: Pcm16WavReader,
  value: { readonly startMs: number; readonly endMs: number },
): readonly [number, number] {
  const start = Math.floor((value.startMs * PCM_SAMPLE_RATE) / 1_000);
  const end = Math.min(
    reader.metadata.frameCount,
    Math.ceil((value.endMs * PCM_SAMPLE_RATE) / 1_000),
  );
  if (end <= start) throw new RecordingAuthoritativeError("Final cache PCM range is invalid");
  return [start, end];
}

function assertCachedBlocks(
  blocks: readonly FunAsrBlock[],
  chunk: SpeechRegion,
): void {
  if (blocks.length > MAX_FINAL_BLOCKS || blocks.some((block, index) =>
    block.seq !== index || block.startMs < chunk.startMs || block.endMs > chunk.endMs)) {
    throw new RecordingAuthoritativeError("Cached ASR blocks violate their source range");
  }
}

function resultBlocks(
  chunks: readonly SpeechRegion[],
  results: ReadonlyMap<string, CachedAsr>,
): FunAsrBlock[] {
  const output: FunAsrBlock[] = [];
  for (const chunk of chunks) {
    const cached = results.get(timeKey(chunk));
    if (cached === undefined) {
      throw new RecordingAuthoritativeError("Final ASR cache is incomplete");
    }
    for (const block of cached.blocks) {
      output.push({ ...block, seq: output.length });
      if (output.length > MAX_FINAL_BLOCKS) {
        throw new RecordingAuthoritativeError("Final transcript exceeds its segment bound");
      }
    }
  }
  return output;
}

function expectedWindows(
  blocks: readonly FunAsrBlock[],
  speechRegions: readonly SpeechRegion[],
): EmbeddingWindow[] {
  return blocks.flatMap((block) => block.endMs - block.startMs < MIN_EMBEDDING_MS
    ? []
    : planEmbeddingWindows(block, speechRegions));
}

export class RecordingAuthoritativeEngine {
  private readonly asr = new Map<string, CachedAsr>();
  private readonly embeddings = new Map<string, CachedEmbedding>();
  private readonly embeddingKeys = new Map<string, string>();
  private finalized = false;
  private reader: RecordingTimelineReader | undefined;
  private vad: RecordingIncrementalVad | undefined;
  private vadThroughFrames = 0;

  constructor(private readonly options: RecordingAuthoritativeEngineOptions) {
    if (!/^[0-9a-f]{64}$/.test(options.engineFingerprint)) {
      throw new TypeError("Authoritative engine fingerprint is invalid");
    }
  }

  async advance(): Promise<void> {
    this.assertActive();
    const timeline = await this.options.chunks.scan();
    if (timeline === null) return;
    this.synchronize(timeline);
    const safeFrameCount = Math.max(0, timeline.frameCount - TIMELINE_SETTLE_FRAMES);
    await this.vad!.advance(safeFrameCount);
    this.vadThroughFrames = safeFrameCount;
    const processedMs = Math.ceil((safeFrameCount * 1_000) / PCM_SAMPLE_RATE);
    const snapshot = this.vad!.snapshot(processedMs);
    for (const chunk of stableVadPrefix(snapshot.asrChunks, this.reader!.metadata.durationMs)) {
      const blocks = await this.ensureAsr(chunk);
      await this.ensureWindows(blocks, snapshot.speechRegions);
    }
  }

  async finalize(): Promise<RecordingAuthoritativeResult> {
    this.assertActive();
    this.finalized = true;
    const timeline = await this.options.chunks.scan();
    if (timeline === null) throw new RecordingAuthoritativeError("Recording has no closed audio");
    this.synchronize(timeline);
    await this.vad!.advance(timeline.frameCount, true);
    this.vadThroughFrames = timeline.frameCount;
    const snapshot = this.vad!.snapshot(this.reader!.metadata.durationMs);
    this.discardObsoleteAsr(snapshot.asrChunks);
    const counts: CacheCounts = { hits: 0, misses: 0 };
    for (const chunk of snapshot.asrChunks) await this.ensureAsr(chunk, counts);
    const blocks = resultBlocks(snapshot.asrChunks, this.asr);
    if (blocks.length === 0) {
      return {
        cacheHits: counts.hits,
        cacheMisses: counts.misses,
        durationMs: this.reader!.metadata.durationMs,
        resultReason: snapshot.asrChunks.length === 0 ? "silent" : "too_short",
        resultStatus: "empty",
        segments: [],
      };
    }
    const windows = expectedWindows(blocks, snapshot.speechRegions);
    for (const window of windows) await this.ensureEmbedding(window, counts);
    const queued = this.cachedEmbeddingQueue(windows);
    const diarized = await this.options.kernels.diarize(
      this.reader!, blocks, snapshot.speechRegions, queued.model,
    );
    if (queued.consumed() !== windows.length) {
      throw new RecordingAuthoritativeError("Final diarization did not consume its exact cache");
    }
    return {
      cacheHits: counts.hits,
      cacheMisses: counts.misses,
      durationMs: this.reader!.metadata.durationMs,
      resultReason: diarized.resultReason,
      resultStatus: diarized.resultStatus,
      segments: diarized.segments,
    };
  }

  private assertActive(): void {
    if (this.finalized) throw new RecordingAuthoritativeError("Recording finalization already ran");
  }

  private synchronize(timeline: RecordingTimeline): void {
    if (this.reader === undefined) {
      this.reset(timeline);
      return;
    }
    try {
      this.reader.update(timeline, this.vadThroughFrames);
    } catch (error) {
      if (!(error instanceof RecordingTimelineChangedError)) throw error;
      this.reset(timeline);
    }
  }

  private reset(timeline: RecordingTimeline): void {
    this.asr.clear();
    this.embeddings.clear();
    this.embeddingKeys.clear();
    this.vadThroughFrames = 0;
    this.reader = new RecordingTimelineReader(
      timeline,
      (chunk, start, end) => this.options.chunks.read(chunk, start, end),
    );
    this.vad = this.options.kernels.createVad(this.reader);
  }

  private async ensureAsr(chunk: SpeechRegion, counts?: CacheCounts): Promise<readonly FunAsrBlock[]> {
    const existing = this.asr.get(timeKey(chunk));
    if (existing !== undefined && counts === undefined) return existing.blocks;
    const [start, end] = frameRange(this.reader!, chunk);
    const samples = await this.reader!.readFrames(start, end);
    const cacheKey = recordingCacheKey(
      "asr", this.options.engineFingerprint, chunk.startMs, chunk.endMs, samples,
    );
    if (existing?.cacheKey === cacheKey) {
      if (counts !== undefined) counts.hits += 1;
      return existing.blocks;
    }
    const stored = await this.options.cache.getAsr(cacheKey);
    if (stored !== null) {
      assertCachedBlocks(stored, chunk);
      this.asr.set(timeKey(chunk), { cacheKey, blocks: stored });
      if (counts !== undefined) counts.hits += 1;
      return stored;
    }
    const result = await this.options.kernels.transcribe(this.reader!, [chunk]);
    assertCachedBlocks(result.blocks, chunk);
    await this.options.cache.putAsr(cacheKey, result.blocks);
    this.asr.set(timeKey(chunk), { cacheKey, blocks: result.blocks });
    if (counts !== undefined) counts.misses += 1;
    return result.blocks;
  }

  private async ensureWindows(
    blocks: readonly FunAsrBlock[],
    speechRegions: readonly SpeechRegion[],
  ): Promise<void> {
    for (const window of expectedWindows(blocks, speechRegions)) {
      await this.ensureEmbedding(window);
    }
  }

  private async ensureEmbedding(window: EmbeddingWindow, counts?: CacheCounts): Promise<string> {
    const windowKey = timeKey(window);
    const existingKey = this.embeddingKeys.get(windowKey);
    if (existingKey !== undefined && counts === undefined && this.embeddings.has(existingKey)) {
      return existingKey;
    }
    const [start, end] = frameRange(this.reader!, window);
    const samples = await this.reader!.readFrames(start, end);
    const key = recordingCacheKey(
      "embedding", this.options.engineFingerprint, window.startMs, window.endMs, samples,
    );
    if (this.embeddings.has(key)) {
      this.embeddingKeys.set(windowKey, key);
      if (counts !== undefined) counts.hits += 1;
      return key;
    }
    const stored = await this.options.cache.getEmbedding(key);
    if (stored !== null) {
      this.embeddings.set(key, stored);
      this.embeddingKeys.set(windowKey, key);
      if (counts !== undefined) counts.hits += 1;
      return key;
    }
    let output: Awaited<ReturnType<SpeakerEmbeddingModel["embed"]>>;
    try {
      output = await this.options.kernels.embeddingModel.embed(samples);
    } catch (failure) {
      this.embeddings.set(key, { failure });
      this.embeddingKeys.set(windowKey, key);
      if (counts !== undefined) counts.misses += 1;
      return key;
    }
    await this.options.cache.putEmbedding(key, output.embedding);
    this.embeddings.set(key, new Float32Array(output.embedding));
    this.embeddingKeys.set(windowKey, key);
    if (counts !== undefined) counts.misses += 1;
    return key;
  }

  private discardObsoleteAsr(finalChunks: readonly SpeechRegion[]): void {
    const keys = new Set(finalChunks.map(timeKey));
    for (const key of this.asr.keys()) {
      if (!keys.has(key)) this.asr.delete(key);
    }
  }

  private cachedEmbeddingQueue(windows: readonly EmbeddingWindow[]): {
    readonly model: SpeakerEmbeddingModel;
    consumed(): number;
  } {
    let index = 0;
    return {
      model: {
        close: async () => undefined,
        embed: async (samples) => {
          const window = windows[index];
          if (window === undefined) {
            throw new RecordingAuthoritativeError("Final diarization exceeded its cache plan");
          }
          const key = recordingCacheKey(
            "embedding",
            this.options.engineFingerprint,
            window.startMs,
            window.endMs,
            samples,
          );
          const cached = this.embeddings.get(key);
          if (cached === undefined) {
            throw new RecordingAuthoritativeError("Final embedding cache order changed");
          }
          index += 1;
          if (!(cached instanceof Float32Array)) throw cached.failure;
          return { embedding: new Float32Array(cached), fbankMs: 0, inferenceMs: 0 };
        },
      },
      consumed: () => index,
    };
  }
}
