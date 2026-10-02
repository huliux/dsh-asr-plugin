import type { SpeechRegion } from "../asr/vad-regions.js";

const STABILITY_AGE_MS = 20_000;
const RETAINED_TAIL_CHUNKS = 2;

export function stableVadPrefix(
  chunks: readonly SpeechRegion[],
  availableMs: number,
): readonly SpeechRegion[] {
  if (!Number.isSafeInteger(availableMs) || availableMs < 0) {
    throw new TypeError("Available recording duration is invalid");
  }
  const eligible = chunks.slice(0, Math.max(0, chunks.length - RETAINED_TAIL_CHUNKS));
  const stableBefore = availableMs - STABILITY_AGE_MS;
  return eligible.filter((chunk) => chunk.endMs <= stableBefore);
}
