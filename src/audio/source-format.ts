import type { FileHandle } from "node:fs/promises";

export type AudioSourceFormat = "wav" | "m4a" | "mp3";

const ISO_BMFF_BRANDS = new Set([
  "M4A ", "M4B ", "isom", "iso2", "mp41", "mp42", "qt  ",
]);

async function readAt(handle: FileHandle, position: number, byteLength: number): Promise<Buffer> {
  const buffer = Buffer.alloc(byteLength);
  const { bytesRead } = await handle.read(buffer, 0, byteLength, position);
  return buffer.subarray(0, bytesRead);
}

function isWav(header: Buffer, fileSize: number): boolean {
  return fileSize >= 12
    && header.toString("ascii", 0, 4) === "RIFF"
    && header.toString("ascii", 8, 12) === "WAVE";
}

function isIsoBmff(header: Buffer, fileSize: number): boolean {
  if (fileSize < 16 || header.byteLength < 16 || header.toString("ascii", 4, 8) !== "ftyp") {
    return false;
  }
  const boxSize = header.readUInt32BE(0);
  if (boxSize < 16 || boxSize > fileSize || boxSize % 4 !== 0) return false;
  for (let offset = 8; offset + 4 <= Math.min(boxSize, header.byteLength); offset += 4) {
    if (offset === 12) continue;
    if (ISO_BMFF_BRANDS.has(header.toString("ascii", offset, offset + 4))) return true;
  }
  return ISO_BMFF_BRANDS.has(header.toString("ascii", 8, 12));
}

function isMpegFrame(header: Buffer, offset = 0): boolean {
  if (header.byteLength - offset < 4) return false;
  const first = header[offset]!;
  const second = header[offset + 1]!;
  const third = header[offset + 2]!;
  const version = (second >> 3) & 0x03;
  const layer = (second >> 1) & 0x03;
  const bitrate = (third >> 4) & 0x0f;
  const sampleRate = (third >> 2) & 0x03;
  return first === 0xff
    && (second & 0xe0) === 0xe0
    && version !== 1
    && layer !== 0
    && bitrate !== 0
    && bitrate !== 0x0f
    && sampleRate !== 0x03;
}

function id3PayloadSize(header: Buffer): number | null {
  if (header.byteLength < 10 || header.toString("ascii", 0, 3) !== "ID3") return null;
  const bytes = [header[6]!, header[7]!, header[8]!, header[9]!];
  if (bytes.some((value) => (value & 0x80) !== 0)) return null;
  return bytes.reduce((size, value) => (size << 7) | value, 0);
}

async function isMp3(handle: FileHandle, header: Buffer, fileSize: number): Promise<boolean> {
  if (isMpegFrame(header)) return true;
  const payloadSize = id3PayloadSize(header);
  if (payloadSize === null) return false;
  const footerSize = (header[5]! & 0x10) === 0 ? 0 : 10;
  const frameOffset = 10 + payloadSize + footerSize;
  if (frameOffset + 4 > fileSize) return false;
  const frameWindow = await readAt(handle, frameOffset, Math.min(4_096, fileSize - frameOffset));
  for (let offset = 0; offset + 4 <= frameWindow.byteLength; offset += 1) {
    if (isMpegFrame(frameWindow, offset)) return true;
  }
  return false;
}

export async function detectAudioSourceFormat(
  handle: FileHandle,
  fileSize: number,
): Promise<AudioSourceFormat | null> {
  const header = await readAt(handle, 0, Math.min(4_096, fileSize));
  if (isWav(header, fileSize)) return "wav";
  if (isIsoBmff(header, fileSize)) return "m4a";
  if (await isMp3(handle, header, fileSize)) return "mp3";
  return null;
}
