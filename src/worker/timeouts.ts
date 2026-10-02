import { MAX_AUDIO_FRAMES, PCM_SAMPLE_RATE } from "../audio/wav-reader.js";

export const WORKER_READY_TIMEOUT_MS = 30_000;
export const WORKER_TERMINATION_GRACE_MS = 2_000;
export const WORKER_TERMINATION_TIMEOUT_MS = 15_000;

const AUDIO_QUANTUM_MS = 30 * 60_000;
const RUN_BASE_MS = 120_000;
const RUN_PER_QUANTUM_MS = 60_000;
const RUN_MAX_MS = 600_000;
const MAX_AUDIO_DURATION_MS = (MAX_AUDIO_FRAMES * 1_000) / PCM_SAMPLE_RATE;

export function workerRunDeadlineMs(durationMs: number): number {
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs > MAX_AUDIO_DURATION_MS
  ) {
    throw new TypeError("Worker duration is invalid");
  }
  const quanta = Math.ceil(durationMs / AUDIO_QUANTUM_MS);
  return Math.min(RUN_MAX_MS, RUN_BASE_MS + quanta * RUN_PER_QUANTUM_MS);
}
