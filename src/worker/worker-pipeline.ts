import { WorkerProtocolError } from "./host-state.js";
import type { WorkerProgressMessage, WorkerResultMessage, WorkerRunMessage } from "./types.js";
import type { AsrResultMessage, AsrRunMessage, DiarizationResultMessage } from "./types.js";
import type { WorkerReadyMessage } from "./types.js";
import { WorkerClientError } from "./worker-client.js";
import type { WorkerRunOptions } from "./worker-client.js";

export interface WorkerRunner {
  run(run: WorkerRunMessage, options?: WorkerRunOptions): Promise<WorkerResultMessage>;
}

export interface WorkerPipelineOptions {
  readonly asr: WorkerRunner;
  readonly diarization: WorkerRunner;
  readonly asrRun: AsrRunMessage;
  readonly diarizationRequestId: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (
    kind: "asr" | "diarization",
    message: WorkerProgressMessage,
  ) => void;
  readonly onReady?: (
    kind: "asr" | "diarization",
    message: WorkerReadyMessage,
  ) => void;
  readonly onHandoff?: () => void;
}

export type WorkerPipelineResult =
  | { readonly type: "empty"; readonly asr: AsrResultMessage }
  | {
    readonly type: "diarized";
    readonly asr: AsrResultMessage;
    readonly diarization: DiarizationResultMessage;
  };

function runOptions(
  options: WorkerPipelineOptions,
  kind: "asr" | "diarization",
): WorkerRunOptions {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined
      ? {}
      : { onProgress: (message: WorkerProgressMessage) => options.onProgress!(kind, message) }),
    ...(options.onReady === undefined
      ? {}
      : { onReady: (message: WorkerReadyMessage) => options.onReady!(kind, message) }),
  };
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw WorkerClientError.cancelled("run");
}

function diarizationRun(
  options: WorkerPipelineOptions,
  asr: AsrResultMessage,
): Extract<WorkerRunMessage, { kind: "diarization" }> {
  return {
    type: "run",
    request_id: options.diarizationRequestId,
    kind: "diarization",
    base_transcript_version: options.asrRun.base_transcript_version,
    payload: {
      audio_path: options.asrRun.payload.audio_path,
      duration_ms: options.asrRun.payload.duration_ms,
      blocks: asr.payload.blocks,
      speech_regions: asr.payload.speech_regions,
    },
  };
}

export async function runWorkerPipeline(
  options: WorkerPipelineOptions,
): Promise<WorkerPipelineResult> {
  assertNotCancelled(options.signal);
  const asr = await options.asr.run(options.asrRun, runOptions(options, "asr"));
  if (asr.kind !== "asr") throw new WorkerProtocolError();
  assertNotCancelled(options.signal);
  if (asr.payload.blocks.length === 0) return { type: "empty", asr };
  options.onHandoff?.();
  const diarization = await options.diarization.run(
    diarizationRun(options, asr),
    runOptions(options, "diarization"),
  );
  if (diarization.kind !== "diarization") throw new WorkerProtocolError();
  return { type: "diarized", asr, diarization };
}
