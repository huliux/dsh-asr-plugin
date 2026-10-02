import { quantizePcm16Sample } from "./pcm16.js";
import { MAX_AUDIO_FRAMES, PCM_SAMPLE_RATE } from "./wav-reader.js";

export const MAX_RECORDING_CHUNKS_PER_TRACK = 4_096;
const MAX_RENDER_FRAMES = PCM_SAMPLE_RATE * 60;

export type RecordingTrack = "mic" | "system";

export interface RecordingChunk {
  readonly id: string;
  readonly track: RecordingTrack;
  readonly startUs: number;
  readonly endUs: number;
  readonly frameCount: number;
}

export interface RecordingTimelineChunk extends RecordingChunk {
  readonly startFrame: number;
  readonly endFrame: number;
}

export interface RecordingTimeline {
  readonly originUs: number;
  readonly frameCount: number;
  readonly chunks: readonly RecordingTimelineChunk[];
}

export type RecordingChunkReader = (
  chunk: RecordingTimelineChunk,
  startFrame: number,
  endFrame: number,
) => Promise<Float32Array>;

export class RecordingTimelineError extends Error {
  readonly code = "INVALID_RECORDING_TIMELINE" as const;

  constructor(message: string) {
    super(message);
    this.name = "RecordingTimelineError";
  }
}

function invalid(message: string): never {
  throw new RecordingTimelineError(message);
}

function framesForMicroseconds(value: number): number {
  const frames = Math.round((value * PCM_SAMPLE_RATE) / 1_000_000);
  if (!Number.isSafeInteger(frames)) invalid("Recording timestamp exceeds the frame range");
  return frames;
}

function assertChunk(chunk: RecordingChunk): void {
  if (
    chunk.id.length < 1 ||
    !["mic", "system"].includes(chunk.track) ||
    !Number.isSafeInteger(chunk.startUs) ||
    !Number.isSafeInteger(chunk.endUs) ||
    chunk.startUs < 0 ||
    chunk.endUs <= chunk.startUs ||
    !Number.isSafeInteger(chunk.frameCount) ||
    chunk.frameCount < 1 ||
    Math.abs(chunk.frameCount - framesForMicroseconds(chunk.endUs - chunk.startUs)) > 1
  ) invalid("Recording chunk is invalid");
}

function assertTrackOrdering(chunks: readonly RecordingChunk[]): void {
  for (const track of ["mic", "system"] as const) {
    const selected = chunks.filter((chunk) => chunk.track === track)
      .sort((left, right) => left.startUs - right.startUs || left.endUs - right.endUs);
    if (selected.length > MAX_RECORDING_CHUNKS_PER_TRACK) {
      invalid("Recording track has too many chunks");
    }
    for (let index = 1; index < selected.length; index += 1) {
      if (selected[index]!.startUs < selected[index - 1]!.endUs) {
        invalid("Recording chunks overlap within one track");
      }
    }
  }
}

function assertFrameOrdering(chunks: readonly RecordingTimelineChunk[]): void {
  for (const track of ["mic", "system"] as const) {
    const selected = chunks.filter((chunk) => chunk.track === track)
      .sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame);
    for (let index = 1; index < selected.length; index += 1) {
      if (selected[index]!.startFrame < selected[index - 1]!.endFrame) {
        invalid("Recording chunks overlap after frame alignment");
      }
    }
  }
}

export function buildRecordingTimeline(input: readonly RecordingChunk[]): RecordingTimeline {
  if (input.length < 1) invalid("Recording has no closed chunks");
  for (const chunk of input) assertChunk(chunk);
  assertTrackOrdering(input);
  const originUs = Math.min(...input.map((chunk) => chunk.startUs));
  const chunks = input.map((chunk) => {
    const startFrame = framesForMicroseconds(chunk.startUs - originUs);
    return { ...chunk, startFrame, endFrame: startFrame + chunk.frameCount };
  }).sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame);
  assertFrameOrdering(chunks);
  const frameCount = Math.max(...chunks.map((chunk) => chunk.endFrame));
  if (frameCount < 1 || frameCount > MAX_AUDIO_FRAMES) invalid("Recording duration is invalid");
  return { originUs, frameCount, chunks };
}

function assertWindow(timeline: RecordingTimeline, startFrame: number, endFrame: number): void {
  if (
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(endFrame) ||
    startFrame < 0 ||
    endFrame <= startFrame ||
    endFrame > timeline.frameCount ||
    endFrame - startFrame > MAX_RENDER_FRAMES
  ) invalid("Recording render window is invalid");
}

async function renderTrack(
  chunks: readonly RecordingTimelineChunk[],
  startFrame: number,
  endFrame: number,
  read: RecordingChunkReader,
): Promise<{ samples: Float32Array; coverage: Uint8Array }> {
  const samples = new Float32Array(endFrame - startFrame);
  const coverage = new Uint8Array(samples.length);
  for (const chunk of chunks) {
    const overlapStart = Math.max(startFrame, chunk.startFrame);
    const overlapEnd = Math.min(endFrame, chunk.endFrame);
    if (overlapStart >= overlapEnd) continue;
    const sourceStart = overlapStart - chunk.startFrame;
    const sourceEnd = overlapEnd - chunk.startFrame;
    const value = await read(chunk, sourceStart, sourceEnd);
    if (value.length !== sourceEnd - sourceStart || value.some((sample) => !Number.isFinite(sample))) {
      invalid("Recording chunk reader returned invalid samples");
    }
    samples.set(value, overlapStart - startFrame);
    coverage.fill(1, overlapStart - startFrame, overlapEnd - startFrame);
  }
  return { samples, coverage };
}

function mixTracks(
  mic: Awaited<ReturnType<typeof renderTrack>>,
  system: Awaited<ReturnType<typeof renderTrack>>,
): Float32Array {
  const mixed = new Float32Array(mic.samples.length);
  for (let index = 0; index < mixed.length; index += 1) {
    const hasMic = mic.coverage[index] === 1;
    const hasSystem = system.coverage[index] === 1;
    if (hasMic && hasSystem) {
      mixed[index] = quantizePcm16Sample((mic.samples[index]! + system.samples[index]!) / 2);
    }
    else if (hasMic) mixed[index] = mic.samples[index]!;
    else if (hasSystem) mixed[index] = system.samples[index]!;
  }
  return mixed;
}

export async function renderRecordingWindow(
  timeline: RecordingTimeline,
  startFrame: number,
  endFrame: number,
  read: RecordingChunkReader,
): Promise<Float32Array> {
  assertWindow(timeline, startFrame, endFrame);
  const [mic, system] = await Promise.all([
    renderTrack(timeline.chunks.filter((chunk) => chunk.track === "mic"), startFrame, endFrame, read),
    renderTrack(timeline.chunks.filter((chunk) => chunk.track === "system"), startFrame, endFrame, read),
  ]);
  return mixTracks(mic, system);
}

export async function renderRecordingTrackWindow(
  timeline: RecordingTimeline,
  track: RecordingTrack,
  startFrame: number,
  endFrame: number,
  read: RecordingChunkReader,
): Promise<Float32Array> {
  assertWindow(timeline, startFrame, endFrame);
  return (await renderTrack(
    timeline.chunks.filter((chunk) => chunk.track === track),
    startFrame,
    endFrame,
    read,
  )).samples;
}
