import { runBoundedVad } from "../asr/bounded-vad.js";
import type { LoadedVadModel } from "../asr/vad-model.js";
import {
  runFunAsrDraftWithLoadedRuntime,
  type LoadedFunAsrRuntime,
} from "../asr/funasr/pipeline.js";
import type { Pcm16WavReader } from "../audio/wav-reader.js";
import { PCM_SAMPLE_RATE } from "../audio/wav-reader.js";
import { stageWorkerFailure } from "../worker/worker-errors.js";
import type { OnlineSpeakerLabeler } from "../diarization/online-labeler.js";
import { MIN_EMBEDDING_MS } from "../diarization/meeting-diarizer.js";
import type { RecordingDraftRecognizer, RecordingDraftUnit } from "./draft-engine.js";

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

function regionFrames(region: { readonly startMs: number; readonly endMs: number }): {
  readonly endFrame: number;
  readonly startFrame: number;
} {
  return {
    startFrame: Math.floor((region.startMs * PCM_SAMPLE_RATE) / 1_000),
    endFrame: Math.ceil((region.endMs * PCM_SAMPLE_RATE) / 1_000),
  };
}

/** Assigns each recognized unit the live speaker label of the region it falls in. */
function labelUnits(
  units: readonly RecordingDraftUnit[],
  regions: readonly { readonly endMs: number; readonly startMs: number; readonly label: string | null }[],
): RecordingDraftUnit[] {
  if (regions.length === 0) return [...units];
  return units.map((unit) => {
    let best: string | null = null;
    let bestOverlap = 0;
    for (const region of regions) {
      const overlap = Math.min(unit.endMs, region.endMs) - Math.max(unit.startMs, region.startMs);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = region.label;
      }
    }
    return { ...unit, speakerLabel: best };
  });
}

export function createRecordingDraftRecognizer(
  vad: LoadedVadModel,
  asr: LoadedFunAsrRuntime,
  speaker?: OnlineSpeakerLabeler,
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
      if (speaker === undefined) return result.units.map(unit => ({ ...unit, speakerLabel: null }));
      const labeled: { readonly endMs: number; readonly label: string | null; readonly startMs: number }[] = [];
      for (const chunk of regions.asrChunks) {
        const label = chunk.endMs - chunk.startMs < MIN_EMBEDDING_MS ? null
          : await speaker.label(await reader.readFrames(...Object.values(regionFrames(chunk)) as [number, number]));
        labeled.push({ endMs: chunk.endMs, label, startMs: chunk.startMs });
      }
      return labelUnits(result.units.map(unit => ({ ...unit, speakerLabel: null as string | null })), labeled);
    } catch (error) {
      throw stageWorkerFailure(error, "asr", "asr");
    }
  };
}
