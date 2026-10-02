import { loadMeetingDiarizer } from "../diarization/factory.js";
import type { MeetingDiarizationResult, MeetingDiarizer } from "../diarization/meeting-diarizer.js";
import type { WorkerEntryConfig } from "./entry-config.js";
import { openManagedPcm16Wav, prepareManagedAudioRoot } from "./managed-audio.js";
import type { LoadedWorkerRuntime } from "./worker-server.js";
import type {
  DiarizationResultPayload,
  DiarizationRunMessage,
} from "./types.js";
import { stageWorkerFailure } from "./worker-errors.js";
import { loadWorkerAssets, requiredAsset } from "./worker-assets.js";

const DIARIZATION_ASSET_IDS = [
  "speaker-embedding-model",
  "fbank-native",
  "hcluster-native",
] as const;

function diarizationPayload(result: MeetingDiarizationResult): DiarizationResultPayload {
  return {
    result_status: result.resultStatus,
    result_reason: result.resultReason,
    segments: result.segments.map((segment) => ({
      seq: segment.seq,
      start_ms: segment.startMs,
      end_ms: segment.endMs,
      speaker_label: segment.speakerLabel,
      text: segment.text,
    })),
    warnings: result.warnings.map((warning) => ({
      code: warning.code,
      seq: warning.seq,
    })),
    metrics: {
      fbank_ms: result.metrics.fbankMs,
      embed_ms: result.metrics.embedMs,
      cluster_ms: result.metrics.clusterMs,
      assign_ms: result.metrics.assignMs,
      max_rss_bytes: process.resourceUsage().maxRSS * 1_024,
    },
  };
}

async function executeDiarization(
  run: DiarizationRunMessage,
  managedRoot: string,
  diarizer: MeetingDiarizer,
  report: Parameters<LoadedWorkerRuntime<"diarization">["execute"]>[1],
): Promise<DiarizationResultPayload> {
  const reader = await openManagedPcm16Wav(
    managedRoot,
    run.payload.audio_path,
    run.payload.duration_ms,
  );
  try {
    await report("fbank", 0);
    let result: MeetingDiarizationResult;
    try {
      result = await diarizer.diarize(
        reader,
        run.payload.blocks.map((block) => ({
          seq: block.seq,
          startMs: block.start_ms,
          endMs: block.end_ms,
          text: block.text,
        })),
        run.payload.speech_regions.map((region) => ({
          startMs: region.start_ms,
          endMs: region.end_ms,
        })),
      );
    } catch (error) {
      throw stageWorkerFailure(error, "diarization", "embed");
    }
    await report("assign", 1);
    return diarizationPayload(result);
  } finally {
    await reader.close();
  }
}

export async function loadDiarizationWorkerRuntime(
  config: WorkerEntryConfig,
): Promise<LoadedWorkerRuntime<"diarization">> {
  const assets = await loadWorkerAssets(config, DIARIZATION_ASSET_IDS);
  const managedRoot = await prepareManagedAudioRoot(config.managedAudioDirectory);
  const diarizer = await loadMeetingDiarizer({
    embeddingModelPath: requiredAsset(assets.paths, "speaker-embedding-model"),
    fbankPath: requiredAsset(assets.paths, "fbank-native"),
    hclusterPath: requiredAsset(assets.paths, "hcluster-native"),
  });
  return {
    engineFingerprint: assets.engineFingerprint,
    execute: (run, report) => executeDiarization(run, managedRoot, diarizer, report),
    close: () => diarizer.close(),
  };
}
