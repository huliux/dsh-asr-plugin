import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { SpeechRegion } from "../../src/asr/vad-regions.js";
import { buildRecordingTimeline } from "../../src/audio/recording-timeline.js";
import type { ClosedRecordingChunks } from "../../src/audio/closed-recording-chunks.js";
import { createMeetingDiarizer } from "../../src/diarization/meeting-diarizer.js";
import {
  RecordingAuthoritativeEngine,
  type RecordingAuthoritativeKernels,
  type RecordingIncrementalVad,
} from "../../src/recording/authoritative-engine.js";
import { openRecordingFinalCache } from "../../src/recording/final-cache.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

function regions(): SpeechRegion[] {
  return [
    { startMs: 0, endMs: 5_000 },
    { startMs: 6_000, endMs: 10_000 },
    { startMs: 11_000, endMs: 15_000 },
    { startMs: 16_000, endMs: 20_000 },
    { startMs: 21_000, endMs: 25_000 },
  ];
}

const transcribeChunk: RecordingAuthoritativeKernels["transcribe"] = async (_reader, input) => ({
  blocks: [{
    seq: 0,
    startMs: input[0]!.startMs,
    endMs: input[0]!.endMs,
    text: `chunk-${input[0]!.startMs}-${input[0]!.endMs}`,
  }],
  emptyReason: null,
  metrics: {
    asrInferenceMs: 1,
    chunkCount: 1,
    featureFrames: 1,
    frontendMs: 1,
    punctuationInferenceMs: 1,
    tokenCount: 1,
  },
});

const diarizeAsSpeakerA: RecordingAuthoritativeKernels["diarize"] = async (
  _reader,
  blocks,
  _speechRegions,
  cachedEmbeddingModel,
) => {
  for (const block of blocks) {
    const start = Math.floor(block.startMs * 16);
    const end = Math.ceil(block.endMs * 16);
    await cachedEmbeddingModel.embed(new Float32Array(end - start).fill(0.25));
  }
  return {
    metrics: {
      assignMs: 0,
      clusterMs: 0,
      embeddedBlockCount: blocks.length,
      embeddingWindowCount: blocks.length,
      embedMs: 0,
      fbankMs: 0,
      unknownBlockCount: 0,
    },
    resultReason: null,
    resultStatus: "completed",
    segments: blocks.map((block) => ({ ...block, speakerLabel: "Speaker A" })),
    speakerCount: 1,
    warnings: [],
  };
};

function revisingVadKernels(
  incrementalRegions: readonly SpeechRegion[],
  finalRegions: readonly SpeechRegion[],
): RecordingAuthoritativeKernels {
  let finalized = false;
  return {
    createVad: () => ({
      advance: async (_frames, final = false) => { finalized = final; },
      snapshot: () => {
        const selected = finalized ? finalRegions : incrementalRegions;
        return { asrChunks: selected, speechRegions: selected };
      },
    }),
    transcribe: transcribeChunk,
    embeddingModel: {
      close: async () => undefined,
      embed: async () => ({
        embedding: new Float32Array(256).fill(0.125),
        fbankMs: 1,
        inferenceMs: 1,
      }),
    },
    diarize: diarizeAsSpeakerA,
  };
}

it("precomputes only stable chunks and finalizes through the same cached kernels", async () => {
  const root = await mkdtemp(join(tmpdir(), "recording-authoritative-"));
  roots.push(root);
  const fingerprint = "a".repeat(64);
  const frameCount = 45 * 16_000;
  const timeline = buildRecordingTimeline([{
    id: "mic",
    track: "mic",
    startUs: 1_000_000,
    endUs: 46_000_000,
    frameCount,
  }]);
  const read = vi.fn(async (_chunk, start: number, end: number) =>
    new Float32Array(end - start).fill(0.25));
  const chunks: ClosedRecordingChunks = {
    scan: async () => timeline,
    read,
  };
  const advance = vi.fn(async () => undefined);
  const vad: RecordingIncrementalVad = {
    advance,
    snapshot: () => ({ asrChunks: regions(), speechRegions: regions() }),
  };
  const transcribe = vi.fn(async (_reader, input: readonly SpeechRegion[]) => ({
    blocks: [{
      seq: 0,
      startMs: input[0]!.startMs,
      endMs: input[0]!.endMs,
      text: `chunk-${input[0]!.startMs}`,
    }],
    emptyReason: null,
    metrics: {
      asrInferenceMs: 1,
      chunkCount: 1,
      featureFrames: 1,
      frontendMs: 1,
      punctuationInferenceMs: 1,
      tokenCount: 1,
    },
  } as const));
  const embed = vi.fn(async () => ({
    embedding: new Float32Array(256).fill(0.125),
    fbankMs: 1,
    inferenceMs: 1,
  }));
  const engine = new RecordingAuthoritativeEngine({
    cache: await openRecordingFinalCache(root, fingerprint),
    chunks,
    engineFingerprint: fingerprint,
    kernels: {
      createVad: () => vad,
      transcribe,
      embeddingModel: { close: async () => undefined, embed },
      async diarize(_reader, blocks, _speechRegions, cachedEmbeddingModel) {
        for (const block of blocks) {
          const start = Math.floor(block.startMs * 16);
          const end = Math.ceil(block.endMs * 16);
          await cachedEmbeddingModel.embed(new Float32Array(end - start).fill(0.25));
        }
        return {
          metrics: {
            assignMs: 0,
            clusterMs: 0,
            embeddedBlockCount: blocks.length,
            embeddingWindowCount: blocks.length,
            embedMs: 0,
            fbankMs: 0,
            unknownBlockCount: 0,
          },
          resultReason: null,
          resultStatus: "completed",
          segments: blocks.map((block) => ({ ...block, speakerLabel: "Speaker A" })),
          speakerCount: 1,
          warnings: [],
        };
      },
    },
  });

  await engine.advance();
  expect(transcribe).toHaveBeenCalledTimes(3);
  expect(embed).toHaveBeenCalledTimes(3);
  const stableReadCount = read.mock.calls.length;
  await engine.advance();
  expect(read).toHaveBeenCalledTimes(stableReadCount);

  const result = await engine.finalize();
  expect(result).toMatchObject({
    durationMs: 45_000,
    resultStatus: "completed",
    resultReason: null,
    cacheHits: 6,
    cacheMisses: 4,
  });
  expect(result.segments).toHaveLength(5);
  expect(result.segments.map((segment) => segment.seq)).toEqual([0, 1, 2, 3, 4]);
  expect(transcribe).toHaveBeenCalledTimes(5);
  expect(embed).toHaveBeenCalledTimes(5);
  expect(advance).toHaveBeenLastCalledWith(frameCount, true);
});

it("isolates one failed speaker window instead of failing the whole recording", async () => {
  const root = await mkdtemp(join(tmpdir(), "recording-authoritative-"));
  roots.push(root);
  const fingerprint = "a".repeat(64);
  const speechRegions = [
    { startMs: 0, endMs: 2_000 },
    { startMs: 10_000, endMs: 12_000 },
  ];
  const frameCount = 15 * 16_000;
  const timeline = buildRecordingTimeline([{
    id: "mic",
    track: "mic",
    startUs: 1_000_000,
    endUs: 16_000_000,
    frameCount,
  }]);
  let embeddingAttempt = 0;
  const engine = new RecordingAuthoritativeEngine({
    cache: await openRecordingFinalCache(root, fingerprint),
    chunks: {
      scan: async () => timeline,
      read: async (_chunk, start, end) => new Float32Array(end - start).fill(0.25),
    },
    engineFingerprint: fingerprint,
    kernels: {
      createVad: () => ({
        advance: async () => undefined,
        snapshot: () => ({ asrChunks: speechRegions, speechRegions }),
      }),
      transcribe: async (_reader, input) => ({
        blocks: [{
          seq: 0,
          startMs: input[0]!.startMs,
          endMs: input[0]!.endMs,
          text: `chunk-${input[0]!.startMs}`,
        }],
        emptyReason: null,
        metrics: {
          asrInferenceMs: 1,
          chunkCount: 1,
          featureFrames: 1,
          frontendMs: 1,
          punctuationInferenceMs: 1,
          tokenCount: 1,
        },
      }),
      embeddingModel: {
        close: async () => undefined,
        async embed() {
          if (embeddingAttempt++ === 0) throw new Error("one invalid embedding");
          const embedding = new Float32Array(256);
          embedding[0] = 1;
          return { embedding, fbankMs: 1, inferenceMs: 1 };
        },
      },
      async diarize(reader, blocks, regions, embeddingModel) {
        const diarizer = createMeetingDiarizer({
          clusterer: {
            cluster: (embeddings) => [embeddings.map((_embedding, index) => index)],
          },
          embeddingModel,
        });
        try {
          return await diarizer.diarize(reader, blocks, regions);
        } finally {
          await diarizer.close();
        }
      },
    },
  });

  await expect(engine.finalize()).resolves.toMatchObject({
    resultStatus: "partial",
    resultReason: "unknown_speaker_segments",
    segments: [
      { seq: 0, speakerLabel: "UNKNOWN" },
      { seq: 1, speakerLabel: "Speaker A" },
    ],
  });
});

it("finalizes revised VAD chunks without publishing obsolete frozen boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "recording-authoritative-"));
  roots.push(root);
  const fingerprint = "a".repeat(64);
  const incrementalRegions = regions();
  const finalRegions = [
    incrementalRegions[0]!,
    { startMs: 6_000, endMs: 10_500 },
    ...incrementalRegions.slice(2),
  ];
  const frameCount = 90 * 16_000;
  const timeline = buildRecordingTimeline([{
    id: "mic",
    track: "mic",
    startUs: 1_000_000,
    endUs: 91_000_000,
    frameCount,
  }]);
  const engine = new RecordingAuthoritativeEngine({
    cache: await openRecordingFinalCache(root, fingerprint),
    chunks: {
      scan: async () => timeline,
      read: async (_chunk, start, end) => new Float32Array(end - start).fill(0.25),
    },
    engineFingerprint: fingerprint,
    kernels: revisingVadKernels(incrementalRegions, finalRegions),
  });

  await engine.advance();
  await expect(engine.finalize()).resolves.toMatchObject({
    resultStatus: "completed",
    segments: [
      { seq: 0, startMs: 0, endMs: 5_000, text: "chunk-0-5000" },
      { seq: 1, startMs: 6_000, endMs: 10_500, text: "chunk-6000-10500" },
      { seq: 2, startMs: 11_000, endMs: 15_000, text: "chunk-11000-15000" },
      { seq: 3, startMs: 16_000, endMs: 20_000, text: "chunk-16000-20000" },
      { seq: 4, startMs: 21_000, endMs: 25_000, text: "chunk-21000-25000" },
    ],
  });
});
