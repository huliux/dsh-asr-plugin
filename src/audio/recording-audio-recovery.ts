import { ManagedAudioError } from "./managed-audio-error.js";
import {
  buildRecordingAudioCandidate,
  recoverPromotedRecordingAudio,
  verifyAndPromoteRecordingAudio,
  type PromotedRecordingAudio,
  type RecordingAudioPaths,
} from "./recording-audio-candidate.js";
import { openClosedRecordingChunks } from "./closed-recording-chunks.js";
import { PCM_SAMPLE_RATE } from "./wav-reader.js";

export type RecordingRecoveryPaths = RecordingAudioPaths;
export type RecoveredRecordingAudio = PromotedRecordingAudio;

function recoveryFailure(message: string, cause?: unknown): ManagedAudioError {
  return new ManagedAudioError(
    "AUDIO_RECOVERY_FAILED",
    message,
    cause === undefined ? undefined : { cause },
  );
}

export async function recoverRecordingAudio(
  paths: RecordingRecoveryPaths,
  maximumDurationMs?: number,
): Promise<RecoveredRecordingAudio> {
  try {
    if (maximumDurationMs !== undefined && (
      !Number.isFinite(maximumDurationMs) || maximumDurationMs <= 0
    )) throw recoveryFailure("Recording recovery duration bound is invalid");
    const promoted = await recoverPromotedRecordingAudio(paths, maximumDurationMs);
    if (promoted !== null) return promoted;
    const chunks = await openClosedRecordingChunks(paths.recordingDirectory);
    if (maximumDurationMs !== undefined) {
      const timeline = await chunks.scan();
      if (timeline !== null && timeline.frameCount * 1_000 > maximumDurationMs * PCM_SAMPLE_RATE) {
        throw recoveryFailure("Recording audio exceeds the verified capture duration");
      }
    }
    const candidate = await buildRecordingAudioCandidate(paths, chunks);
    return await verifyAndPromoteRecordingAudio(paths, candidate);
  } catch (error) {
    throw recoveryFailure("Recording audio could not be recovered", error);
  }
}
