import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

import { AudioReadError } from "./errors.js";
import { pcm16Sample } from "./pcm16.js";

export const PCM_SAMPLE_RATE = 16_000;
export const MAX_AUDIO_FRAMES = PCM_SAMPLE_RATE * 60 * 60 * 4;
export const MAX_PCM_RANGE_FRAMES = PCM_SAMPLE_RATE * 60;

const PCM_CHANNELS = 1;
const PCM_BIT_DEPTH = 16;
const PCM_BLOCK_ALIGN = 2;
const PCM_BYTE_RATE = PCM_SAMPLE_RATE * PCM_BLOCK_ALIGN;
const MAX_CHUNK_COUNT = 1_024;
const PCM_SUBFORMAT_GUID = Buffer.from(
  "0100000000001000800000aa00389b71",
  "hex",
);

export interface Pcm16WavMetadata {
  readonly bitDepth: 16;
  readonly channels: 1;
  readonly dataByteLength: number;
  readonly dataOffset: number;
  readonly durationMs: number;
  readonly frameCount: number;
  readonly sampleRate: 16_000;
}

export interface Pcm16WavReader {
  readonly metadata: Pcm16WavMetadata;
  close(): Promise<void>;
  readFrames(startFrame: number, endFrame: number): Promise<Float32Array>;
  readFramesInto(
    startFrame: number,
    endFrame: number,
    target: Float32Array,
    targetOffset?: number,
  ): Promise<void>;
}

interface PcmFormat {
  bitDepth: number;
  blockAlign: number;
  byteRate: number;
  channels: number;
  formatTag: number;
  sampleRate: number;
}

function invalidHeader(message: string): AudioReadError {
  return new AudioReadError("INVALID_HEADER", message);
}

function ioFailure(message: string, cause?: unknown): AudioReadError {
  return new AudioReadError(
    "IO_FAILURE",
    message,
    cause === undefined ? undefined : { cause },
  );
}

async function readExact(
  handle: FileHandle,
  position: number,
  byteLength: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(byteLength);
  await readExactInto(handle, buffer, position, byteLength);
  return buffer;
}

async function readExactInto(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
  byteLength: number,
): Promise<void> {
  let offset = 0;
  while (offset < byteLength) {
    const result = await handle.read(
      buffer,
      offset,
      byteLength - offset,
      position + offset,
    );
    if (result.bytesRead === 0) throw invalidHeader("Truncated WAV file");
    offset += result.bytesRead;
  }
}

function parseFormat(buffer: Buffer): PcmFormat {
  if (
    buffer.byteLength !== 16 &&
    buffer.byteLength !== 18 &&
    buffer.byteLength !== 40
  ) {
    throw invalidHeader("Invalid PCM fmt chunk length");
  }
  if (buffer.byteLength === 18 && buffer.readUInt16LE(16) !== 0) {
    throw invalidHeader("Unexpected PCM fmt extension");
  }
  let formatTag = buffer.readUInt16LE(0);
  if (buffer.byteLength === 40) {
    const validExtensiblePcm =
      formatTag === 0xfffe &&
      buffer.readUInt16LE(16) === 22 &&
      buffer.readUInt16LE(18) === PCM_BIT_DEPTH &&
      (buffer.readUInt32LE(20) === 0 || buffer.readUInt32LE(20) === 4) &&
      buffer.subarray(24, 40).equals(PCM_SUBFORMAT_GUID);
    if (!validExtensiblePcm) throw invalidHeader("Invalid extensible PCM format");
    formatTag = 1;
  }
  return {
    formatTag,
    channels: buffer.readUInt16LE(2),
    sampleRate: buffer.readUInt32LE(4),
    byteRate: buffer.readUInt32LE(8),
    blockAlign: buffer.readUInt16LE(12),
    bitDepth: buffer.readUInt16LE(14),
  };
}

function assertManagedFormat(format: PcmFormat): void {
  if (
    format.formatTag !== 1 ||
    format.channels !== PCM_CHANNELS ||
    format.sampleRate !== PCM_SAMPLE_RATE ||
    format.byteRate !== PCM_BYTE_RATE ||
    format.blockAlign !== PCM_BLOCK_ALIGN ||
    format.bitDepth !== PCM_BIT_DEPTH
  ) {
    throw new AudioReadError(
      "UNSUPPORTED_FORMAT",
      "WAV must be mono 16 kHz 16-bit PCM",
    );
  }
}

function assertChunkBounds(
  payloadOffset: number,
  byteLength: number,
  fileSize: number,
): number {
  const paddedLength = byteLength + (byteLength % 2);
  const nextOffset = payloadOffset + paddedLength;
  if (!Number.isSafeInteger(nextOffset) || nextOffset > fileSize) {
    throw invalidHeader("WAV chunk exceeds the RIFF boundary");
  }
  return nextOffset;
}

async function parseChunks(
  handle: FileHandle,
  fileSize: number,
): Promise<{ dataByteLength: number; dataOffset: number; format: PcmFormat }> {
  let data: { dataByteLength: number; dataOffset: number } | undefined;
  let format: PcmFormat | undefined;
  let offset = 12;
  let chunkCount = 0;
  while (offset < fileSize) {
    if (++chunkCount > MAX_CHUNK_COUNT || fileSize - offset < 8) {
      throw invalidHeader("Invalid WAV chunk table");
    }
    const header = await readExact(handle, offset, 8);
    const id = header.toString("ascii", 0, 4);
    const byteLength = header.readUInt32LE(4);
    const payloadOffset = offset + 8;
    const nextOffset = assertChunkBounds(payloadOffset, byteLength, fileSize);
    if (id === "fmt ") {
      if (format !== undefined) throw invalidHeader("Duplicate fmt chunk");
      if (byteLength !== 16 && byteLength !== 18 && byteLength !== 40) {
        throw invalidHeader("Invalid PCM fmt chunk length");
      }
      format = parseFormat(await readExact(handle, payloadOffset, byteLength));
    } else if (id === "data") {
      if (data !== undefined || format === undefined) {
        throw invalidHeader("Invalid data chunk ordering");
      }
      data = { dataByteLength: byteLength, dataOffset: payloadOffset };
    }
    offset = nextOffset;
  }
  if (offset !== fileSize || format === undefined || data === undefined) {
    throw invalidHeader("WAV requires one fmt chunk and one data chunk");
  }
  return { ...data, format };
}

async function parseMetadata(
  handle: FileHandle,
  fileSize: number,
): Promise<Pcm16WavMetadata> {
  if (!Number.isSafeInteger(fileSize) || fileSize < 12) {
    throw invalidHeader("WAV file is too small");
  }
  const riff = await readExact(handle, 0, 12);
  if (riff.toString("ascii", 0, 4) !== "RIFF" || riff.toString("ascii", 8, 12) !== "WAVE") {
    throw invalidHeader("Missing RIFF/WAVE signature");
  }
  if (riff.readUInt32LE(4) + 8 !== fileSize) {
    throw invalidHeader("RIFF size does not match the opened file");
  }
  const parsed = await parseChunks(handle, fileSize);
  assertManagedFormat(parsed.format);
  if (parsed.dataByteLength % PCM_BLOCK_ALIGN !== 0) {
    throw invalidHeader("PCM data is not frame-aligned");
  }
  const frameCount = parsed.dataByteLength / PCM_BLOCK_ALIGN;
  if (frameCount > MAX_AUDIO_FRAMES) {
    throw new AudioReadError("AUDIO_TOO_LONG", "WAV exceeds four hours");
  }
  return {
    bitDepth: PCM_BIT_DEPTH,
    channels: PCM_CHANNELS,
    dataByteLength: parsed.dataByteLength,
    dataOffset: parsed.dataOffset,
    durationMs: Math.ceil((frameCount * 1_000) / PCM_SAMPLE_RATE),
    frameCount,
    sampleRate: PCM_SAMPLE_RATE,
  };
}

function assertRange(startFrame: number, endFrame: number, frameCount: number): void {
  if (
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(endFrame) ||
    startFrame < 0 ||
    endFrame < startFrame ||
    endFrame > frameCount ||
    endFrame - startFrame > MAX_PCM_RANGE_FRAMES
  ) {
    throw new AudioReadError("RANGE_INVALID", "PCM frame range is invalid");
  }
}

function decodePcm16Into(
  buffer: Buffer,
  target: Float32Array,
  targetOffset: number,
): void {
  const sampleCount = buffer.byteLength / PCM_BLOCK_ALIGN;
  for (let index = 0; index < sampleCount; index += 1) {
    const value = buffer.readInt16LE(index * PCM_BLOCK_ALIGN);
    target[targetOffset + index] = pcm16Sample(value);
  }
}

function assertTarget(
  target: Float32Array,
  targetOffset: number,
  sampleCount: number,
): void {
  if (
    !(target instanceof Float32Array) ||
    !Number.isSafeInteger(targetOffset) ||
    targetOffset < 0 ||
    targetOffset + sampleCount > target.length
  ) {
    throw new AudioReadError("RANGE_INVALID", "PCM target range is invalid");
  }
}

class OpenPcm16WavReader implements Pcm16WavReader {
  private closed = false;
  private reading = false;
  private scratch = Buffer.alloc(0);

  constructor(
    private readonly handle: FileHandle,
    readonly metadata: Pcm16WavMetadata,
  ) {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }

  async readFrames(startFrame: number, endFrame: number): Promise<Float32Array> {
    assertRange(startFrame, endFrame, this.metadata.frameCount);
    const samples = new Float32Array(endFrame - startFrame);
    await this.readFramesInto(startFrame, endFrame, samples);
    return samples;
  }

  async readFramesInto(
    startFrame: number,
    endFrame: number,
    target: Float32Array,
    targetOffset = 0,
  ): Promise<void> {
    assertRange(startFrame, endFrame, this.metadata.frameCount);
    assertTarget(target, targetOffset, endFrame - startFrame);
    if (this.closed) throw ioFailure("WAV reader is closed");
    if (this.reading) throw ioFailure("Concurrent WAV range reads are not supported");
    this.reading = true;
    try {
      const byteLength = (endFrame - startFrame) * PCM_BLOCK_ALIGN;
      if (this.scratch.byteLength < byteLength) {
        this.scratch = Buffer.allocUnsafe(byteLength);
      }
      const bytes = this.scratch.subarray(0, byteLength);
      await readExactInto(
        this.handle,
        bytes,
        this.metadata.dataOffset + startFrame * PCM_BLOCK_ALIGN,
        byteLength,
      );
      decodePcm16Into(bytes, target, targetOffset);
    } catch (error) {
      if (error instanceof AudioReadError && error.reason !== "INVALID_HEADER") throw error;
      throw ioFailure("Failed to read PCM frame range", error);
    } finally {
      this.reading = false;
    }
  }
}

export async function openPcm16Wav(filePath: string): Promise<Pcm16WavReader> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    throw ioFailure("Failed to open WAV file", error);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw ioFailure("WAV input is not a regular file");
    return new OpenPcm16WavReader(
      handle,
      await parseMetadata(handle, stats.size),
    );
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof AudioReadError) throw error;
    throw ioFailure("Failed to inspect WAV file", error);
  }
}
