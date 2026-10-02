import { open, writeFile } from "node:fs/promises";

interface WaveOptions {
  bitDepth?: number;
  blockAlign?: number;
  byteRate?: number;
  channels?: number;
  extensible?: boolean;
  extraChunks?: readonly { id: string; payload: Buffer }[];
  formatTag?: number;
  sampleRate?: number;
}

function chunk(id: string, payload: Buffer): Buffer {
  if (Buffer.byteLength(id, "ascii") !== 4) {
    throw new Error("WAV chunk IDs must contain four ASCII bytes");
  }
  const result = Buffer.alloc(8 + payload.byteLength + (payload.byteLength % 2));
  result.write(id, 0, 4, "ascii");
  result.writeUInt32LE(payload.byteLength, 4);
  payload.copy(result, 8);
  return result;
}

function pcmBytes(samples: ArrayLike<number>): Buffer {
  const result = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    result.writeInt16LE(samples[index] ?? 0, index * 2);
  }
  return result;
}

export function createWave(
  samples: ArrayLike<number>,
  options: WaveOptions = {},
): Buffer {
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 16_000;
  const bitDepth = options.bitDepth ?? 16;
  const blockAlign = options.blockAlign ?? channels * (bitDepth / 8);
  const byteRate = options.byteRate ?? sampleRate * blockAlign;
  const format = Buffer.alloc(options.extensible === true ? 40 : 16);
  format.writeUInt16LE(options.extensible === true ? 0xfffe : (options.formatTag ?? 1), 0);
  format.writeUInt16LE(channels, 2);
  format.writeUInt32LE(sampleRate, 4);
  format.writeUInt32LE(byteRate, 8);
  format.writeUInt16LE(blockAlign, 12);
  format.writeUInt16LE(bitDepth, 14);
  if (options.extensible === true) {
    format.writeUInt16LE(22, 16);
    format.writeUInt16LE(bitDepth, 18);
    format.writeUInt32LE(channels === 1 ? 4 : 0, 20);
    Buffer.from("0100000000001000800000aa00389b71", "hex").copy(format, 24);
  }
  const chunks = [
    chunk("fmt ", format),
    ...(options.extraChunks ?? []).map(({ id, payload }) => chunk(id, payload)),
    chunk("data", pcmBytes(samples)),
  ];
  const payload = Buffer.concat([Buffer.from("WAVE"), ...chunks]);
  const result = Buffer.alloc(8 + payload.byteLength);
  result.write("RIFF", 0, 4, "ascii");
  result.writeUInt32LE(payload.byteLength, 4);
  payload.copy(result, 8);
  return result;
}

export async function writeSparseWave(
  filePath: string,
  frameCount: number,
): Promise<void> {
  const header = createWave([]);
  const dataBytes = frameCount * 2;
  header.writeUInt32LE(36 + dataBytes, 4);
  header.writeUInt32LE(dataBytes, 40);
  await writeFile(filePath, header);
  const handle = await open(filePath, "r+");
  try {
    await handle.truncate(44 + dataBytes);
  } finally {
    await handle.close();
  }
}
