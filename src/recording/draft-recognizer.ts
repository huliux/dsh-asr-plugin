import { runBoundedVad } from "../asr/bounded-vad.js";
import type { LoadedVadModel } from "../asr/vad-model.js";
import {
  runFunAsrDraftWithLoadedRuntime,
  type LoadedFunAsrRuntime,
} from "../asr/funasr/pipeline.js";
import type { Pcm16WavReader } from "../audio/wav-reader.js";
import { PCM_SAMPLE_RATE } from "../audio/wav-reader.js";
import { stageWorkerFailure } from "../worker/worker-errors.js";
import type { RecordingDraftRecognizer } from "./draft-engine.js";

function assertRange(startFrame: number, endFrame: number, frameCount: number): void {
  if (
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(endFrame) ||
    startFrame < 0 ||
    endFrame < startFrame ||
    endFrame > frameCount
  ) throw new TypeError("Draft PCM range is invalid");
}

function samplesReader(samples: Float32Array): Pcm16WavReader {
  const frameCount = samples.length;
  return {
    metadata: {
      bitDepth: 16,
      channels: 1,
      dataByteLength: frameCount * 2,
      dataOffset: 44,
      durationMs: Math.ceil((frameCount * 1_000) / PCM_SAMPLE_RATE),
      frameCount,
      sampleRate: PCM_SAMPLE_RATE,
    },
    async close() {},
    async readFrames(startFrame, endFrame) {
      assertRange(startFrame, endFrame, frameCount);
      return samples.slice(startFrame, endFrame);
    },
    async readFramesInto(startFrame, endFrame, target, targetOffset = 0) {
      assertRange(startFrame, endFrame, frameCount);
      if (
        !(target instanceof Float32Array) ||
        !Number.isSafeInteger(targetOffset) ||
        targetOffset < 0 ||
        targetOffset + endFrame - startFrame > target.length
      ) throw new TypeError("Draft PCM target range is invalid");
      target.set(samples.subarray(startFrame, endFrame), targetOffset);
    },
  };
}

export function createRecordingDraftRecognizer(
  vad: LoadedVadModel,
  asr: LoadedFunAsrRuntime,
): RecordingDraftRecognizer {
  return async (samples) => {
    const reader = samplesReader(samples);
    let regions: Awaited<ReturnType<typeof runBoundedVad>>;
    try {
      regions = await runBoundedVad(reader, vad);
    } catch (error) {
      throw stageWorkerFailure(error, "asr", "vad");
    }
    try {
      const result = await runFunAsrDraftWithLoadedRuntime(reader, regions.asrChunks, asr);
      return result.units;
    } catch (error) {
      throw stageWorkerFailure(error, "asr", "asr");
    }
  };
}
