import type { SpeechRegion } from "../asr/vad-regions.js";

export interface EmbeddingBlockTime {
  readonly endMs: number;
  readonly seq: number;
  readonly startMs: number;
  readonly text: string;
}

export interface EmbeddingWindow {
  readonly endMs: number;
  readonly startMs: number;
}

const WINDOW_MS = 6_000;
const STEP_MS = 3_000;
const LONG_BLOCK_THRESHOLD_MS = WINDOW_MS + STEP_MS;
const MIN_SPEECH_OVERLAP_MS = 1_000;

function longBlockWindows(block: EmbeddingBlockTime): EmbeddingWindow[] {
  const windows: EmbeddingWindow[] = [];
  for (let startMs = block.startMs; startMs + WINDOW_MS <= block.endMs; startMs += STEP_MS) {
    windows.push({ startMs, endMs: startMs + WINDOW_MS });
  }
  const finalStart = block.endMs - WINDOW_MS;
  if (windows.at(-1)?.startMs !== finalStart) {
    windows.push({ startMs: finalStart, endMs: block.endMs });
  }
  return windows;
}

function speechOverlap(window: EmbeddingWindow, regions: readonly SpeechRegion[]): number {
  let overlap = 0;
  for (const region of regions) {
    const start = Math.max(window.startMs, region.startMs);
    const end = Math.min(window.endMs, region.endMs);
    if (end > start) overlap += end - start;
  }
  return overlap;
}

export function planEmbeddingWindows(
  block: EmbeddingBlockTime,
  speechRegions: readonly SpeechRegion[],
): EmbeddingWindow[] {
  if (block.endMs - block.startMs <= LONG_BLOCK_THRESHOLD_MS) {
    return [{ startMs: block.startMs, endMs: block.endMs }];
  }
  const windows = longBlockWindows(block);
  if (speechRegions.length === 0 || windows.length === 1) return windows;
  const overlaps = windows.map((window) => speechOverlap(window, speechRegions));
  const gated = windows.filter((_, index) => overlaps[index]! >= MIN_SPEECH_OVERLAP_MS);
  if (gated.length > 0) return gated;
  const best = Math.max(...overlaps);
  return [windows[overlaps.indexOf(best)]!];
}
