import { parseProcessingIdentity } from "../assets/processing-identity.js";
import type { ProcessingIdentity } from "../assets/processing-identity.js";
import type { RecordingSessionWorkerFactory } from "../recording/recording-session.js";
import type { WorkerRunner } from "../worker/worker-pipeline.js";

export interface MeetingRuntimeSnapshot {
  readonly asr: WorkerRunner;
  readonly diarization: WorkerRunner;
  readonly engineFingerprint: string;
  readonly processingIdentity: ProcessingIdentity;
  readonly recordingWorker?: RecordingSessionWorkerFactory;
}

export function freezeMeetingRuntime(runtime: MeetingRuntimeSnapshot): MeetingRuntimeSnapshot {
  const processingIdentity = parseProcessingIdentity(runtime.processingIdentity);
  if (runtime.engineFingerprint !== processingIdentity.engineFingerprint) {
    throw new TypeError("Meeting runtime identity does not match its engine");
  }
  return Object.freeze({ ...runtime, processingIdentity });
}
