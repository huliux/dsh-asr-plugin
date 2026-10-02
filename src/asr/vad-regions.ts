import { VadProcessingError } from "./errors.js";

export interface SpeechBlock {
  readonly endMs: number;
  readonly speakerTurn: number;
  readonly startMs: number;
}

export interface SpeechRegion {
  readonly endMs: number;
  readonly startMs: number;
}

const MAX_SILENCE_MS = 5_000;
const MIN_CHUNK_MS = 10_000;
const PADDING_MS = 100;
const SPEAKER_TURN_THRESHOLD = 0.4;
const MAX_ASR_CHUNK_MS = 60_000;
const MIN_ASR_TAIL_MS = 100;
const MAX_SPEECH_REGIONS = 20_000;

function invalidRegions(message: string): never {
  throw new VadProcessingError("MODEL_INFERENCE_FAILED", message);
}

function assertBlocks(blocks: readonly SpeechBlock[], durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    invalidRegions("Invalid audio duration for VAD regions");
  }
  let previousStart = -1;
  for (const block of blocks) {
    if (
      !Number.isSafeInteger(block.startMs) ||
      !Number.isSafeInteger(block.endMs) ||
      block.startMs < 0 ||
      block.startMs > block.endMs ||
      block.endMs > durationMs ||
      block.startMs < previousStart ||
      !Number.isFinite(block.speakerTurn) ||
      block.speakerTurn < 0
    ) {
      invalidRegions("Invalid VAD speech block");
    }
    previousStart = block.startMs;
  }
}

function mergeSeparatedBlock(
  chunks: SpeechBlock[],
  block: SpeechBlock,
): void {
  const last = chunks.at(-1)!;
  const gap = block.startMs - last.endMs;
  if (last.endMs - last.startMs >= MIN_CHUNK_MS) {
    chunks.push(block);
  } else if (gap < MAX_SILENCE_MS) {
    chunks[chunks.length - 1] = { ...last, endMs: block.endMs };
  } else if (chunks.length > 1 && last.startMs - chunks.at(-2)!.endMs < MAX_SILENCE_MS) {
    const previous = chunks.at(-2)!;
    chunks[chunks.length - 2] = { ...previous, endMs: last.endMs };
    chunks[chunks.length - 1] = block;
  } else {
    chunks.push(block);
  }
}

function mergeSpeakerTurn(
  chunks: SpeechBlock[],
  blocks: readonly SpeechBlock[],
  index: number,
): void {
  const block = blocks[index]!;
  const last = chunks.at(-1)!;
  if (last.endMs - last.startMs >= MIN_CHUNK_MS) {
    chunks.push(block);
    return;
  }
  const next = blocks[index + 1];
  if (chunks.length > 1 && next !== undefined && next.speakerTurn < SPEAKER_TURN_THRESHOLD) {
    const previous = chunks.at(-2)!;
    chunks[chunks.length - 2] = { ...previous, endMs: last.endMs };
    chunks[chunks.length - 1] = block;
  } else {
    chunks[chunks.length - 1] = { ...last, endMs: block.endMs };
  }
}

function mergeAdjacentBlocks(blocks: readonly SpeechBlock[]): SpeechBlock[] {
  const chunks: SpeechBlock[] = [];
  blocks.forEach((block, index) => {
    if (chunks.length === 0) return void chunks.push({ ...block });
    const last = chunks.at(-1)!;
    if (block.startMs - last.endMs >= MAX_SILENCE_MS / 2) {
      mergeSeparatedBlock(chunks, { ...block });
    } else if (block.speakerTurn < SPEAKER_TURN_THRESHOLD) {
      chunks[chunks.length - 1] = { ...last, endMs: block.endMs };
    } else {
      mergeSpeakerTurn(chunks, blocks, index);
    }
  });
  return chunks;
}

function mergeTrailingShortChunk(chunks: SpeechBlock[]): void {
  if (chunks.length < 2) return;
  const last = chunks.at(-1)!;
  const previous = chunks.at(-2)!;
  if (
    last.endMs - last.startMs <= MIN_CHUNK_MS &&
    last.startMs - previous.endMs <= MAX_SILENCE_MS
  ) {
    chunks[chunks.length - 2] = { ...previous, endMs: last.endMs };
    chunks.pop();
  }
}

function padChunks(
  chunks: readonly SpeechBlock[],
  durationMs: number,
): SpeechRegion[] {
  const padded = chunks.flatMap((chunk, index) => {
    const previous = chunks[index - 1];
    const next = chunks[index + 1];
    const startPadding =
      previous !== undefined && chunk.startMs - previous.endMs <= 150
        ? PADDING_MS / 4
        : PADDING_MS;
    const endPadding =
      next !== undefined && next.startMs - chunk.endMs <= 150
        ? PADDING_MS / 4
        : PADDING_MS;
    const startMs = Math.max(0, chunk.startMs - startPadding);
    const endMs = Math.min(durationMs, chunk.endMs + endPadding);
    return startMs < endMs ? [{ startMs, endMs }] : [];
  });
  for (let index = 1; index < padded.length; index += 1) {
    const previous = padded[index - 1]!;
    const current = padded[index]!;
    if (current.startMs < previous.endMs) {
      const handoffMs = Math.floor((current.startMs + previous.endMs) / 2);
      padded[index - 1] = { ...previous, endMs: handoffMs };
      padded[index] = { ...current, startMs: handoffMs };
    }
  }
  return padded;
}

export function mergeSpeechBlocks(
  blocks: readonly SpeechBlock[],
  durationMs: number,
): SpeechRegion[] {
  assertBlocks(blocks, durationMs);
  if (blocks.length === 0) return [];
  if (blocks.length > MAX_SPEECH_REGIONS) {
    throw new VadProcessingError("RESOURCE_LIMIT", "Too many VAD speech blocks");
  }
  const chunks = mergeAdjacentBlocks(blocks);
  mergeTrailingShortChunk(chunks);
  return padChunks(chunks, durationMs);
}

export function splitSpeechRegions(
  regions: readonly SpeechRegion[],
): SpeechRegion[] {
  const chunks: SpeechRegion[] = [];
  for (const region of regions) {
    if (
      !Number.isSafeInteger(region.startMs) ||
      !Number.isSafeInteger(region.endMs) ||
      region.startMs < 0 ||
      region.startMs >= region.endMs
    ) {
      invalidRegions("Invalid speech region");
    }
    const firstChunk = chunks.length;
    for (let startMs = region.startMs; startMs < region.endMs; startMs += MAX_ASR_CHUNK_MS) {
      chunks.push({ startMs, endMs: Math.min(startMs + MAX_ASR_CHUNK_MS, region.endMs) });
      if (chunks.length > MAX_SPEECH_REGIONS) {
        throw new VadProcessingError("RESOURCE_LIMIT", "Too many ASR chunks");
      }
    }
    const tail = chunks.at(-1)!;
    if (chunks.length - firstChunk > 1 && tail.endMs - tail.startMs < MIN_ASR_TAIL_MS) {
      const previous = chunks.at(-2)!;
      const handoffMs = tail.endMs - MIN_ASR_TAIL_MS;
      chunks[chunks.length - 2] = { ...previous, endMs: handoffMs };
      chunks[chunks.length - 1] = { ...tail, startMs: handoffMs };
    }
  }
  return chunks;
}
