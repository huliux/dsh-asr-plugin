import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_AUDIO_FRAMES,
  MAX_PCM_RANGE_FRAMES,
  openPcm16Wav,
} from "../../src/audio/wav-reader.js";
import { createWave, writeSparseWave } from "../helpers/wav-fixture.js";

const temporaryDirectories: string[] = [];

async function fixturePath(name = "audio.wav"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-asr-wav-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("openPcm16Wav", () => {
  it("解析带奇数长度未知 chunk 的 PCM WAV 并按帧读取", async () => {
    const filePath = await fixturePath();
    await writeFile(
      filePath,
      createWave([-32_768, -16_384, 0, 16_384, 32_767], {
        extraChunks: [{ id: "JUNK", payload: Buffer.from([1, 2, 3]) }],
      }),
    );
    const reader = await openPcm16Wav(filePath);
    try {
      expect(reader.metadata).toMatchObject({
        bitDepth: 16,
        channels: 1,
        frameCount: 5,
        sampleRate: 16_000,
      });
      const samples = await reader.readFrames(1, 4);
      expect([...samples]).toEqual([
        -0.5,
        0,
        expect.closeTo(16_384 / 32_767, 6),
      ]);
      const target = new Float32Array(5).fill(9);
      await reader.readFramesInto(1, 4, target, 1);
      expect([...target]).toEqual([
        9,
        -0.5,
        0,
        expect.closeTo(16_384 / 32_767, 6),
        9,
      ]);
    } finally {
      await reader.close();
    }
  });

  it("解析与读取使用同一个已打开文件描述符", async () => {
    const filePath = await fixturePath();
    await writeFile(filePath, createWave([1_000]));
    const reader = await openPcm16Wav(filePath);
    const originalPath = `${filePath}.original`;
    await rename(filePath, originalPath);
    await writeFile(filePath, createWave([2_000]));
    try {
      const samples = await reader.readFrames(0, 1);
      expect(samples[0]).toBeCloseTo(1_000 / 32_767, 6);
    } finally {
      await reader.close();
    }
  });

  it("接受 afconvert 使用的精确 extensible PCM 形式", async () => {
    const filePath = await fixturePath();
    await writeFile(filePath, createWave([1_000, -1_000], { extensible: true }));

    const reader = await openPcm16Wav(filePath);
    try {
      await expect(reader.readFrames(0, 2)).resolves.toHaveLength(2);
    } finally {
      await reader.close();
    }
  });

  it("拒绝伪造的 extensible PCM subtype", async () => {
    const filePath = await fixturePath();
    const wave = createWave([1_000], { extensible: true });
    wave[44] = wave[44]! ^ 0xff;
    await writeFile(filePath, wave);

    await expect(openPcm16Wav(filePath)).rejects.toMatchObject({
      code: "AUDIO_READ_FAILED",
      reason: "INVALID_HEADER",
    });
  });

  it.each([
    ["stereo", { channels: 2 }],
    ["8 kHz", { sampleRate: 8_000 }],
    ["float", { formatTag: 3 }],
    ["24-bit", { bitDepth: 24 }],
    ["bad block align", { blockAlign: 4 }],
    ["bad byte rate", { byteRate: 1 }],
  ] as const)("拒绝不受管的 %s WAV", async (_label, options) => {
    const filePath = await fixturePath();
    await writeFile(filePath, createWave([0, 0], options));

    await expect(openPcm16Wav(filePath)).rejects.toMatchObject({
      code: "AUDIO_READ_FAILED",
      reason: "UNSUPPORTED_FORMAT",
    });
  });

  it.each([
    ["missing RIFF", (wave: Buffer) => wave.subarray(4)],
    ["declared size overflow", (wave: Buffer) => {
      wave.writeUInt32LE(wave.byteLength + 100, 4);
      return wave;
    }],
    ["truncated data", (wave: Buffer) => wave.subarray(0, wave.byteLength - 1)],
    ["oversized fmt chunk", (wave: Buffer) => {
      wave.writeUInt32LE(0xffff_fff0, 16);
      return wave;
    }],
    ["unaligned PCM data", (wave: Buffer) => {
      wave.writeUInt32LE(1, 40);
      return wave;
    }],
  ] as const)("拒绝畸形 WAV：%s", async (_label, mutate) => {
    const filePath = await fixturePath();
    await writeFile(filePath, mutate(createWave([1, 2, 3])));

    await expect(openPcm16Wav(filePath)).rejects.toMatchObject({
      code: "AUDIO_READ_FAILED",
      reason: "INVALID_HEADER",
    });
  });

  it("拒绝超过四小时的规范 WAV", async () => {
    const filePath = await fixturePath();
    await writeSparseWave(filePath, MAX_AUDIO_FRAMES + 1);

    await expect(openPcm16Wav(filePath)).rejects.toMatchObject({
      code: "AUDIO_READ_FAILED",
      reason: "AUDIO_TOO_LONG",
    });
  });

  it("拒绝越界、非整数和超过 60 秒的区间读取", async () => {
    const filePath = await fixturePath();
    await writeSparseWave(filePath, MAX_PCM_RANGE_FRAMES + 1);
    const reader = await openPcm16Wav(filePath);
    try {
      for (const range of [
        [-1, 1],
        [0.5, 1],
        [2, 1],
        [0, MAX_PCM_RANGE_FRAMES + 1],
        [0, reader.metadata.frameCount + 1],
      ] as const) {
        const [startFrame, endFrame] = range;
        await expect(reader.readFrames(startFrame, endFrame)).rejects.toMatchObject({
          code: "AUDIO_READ_FAILED",
          reason: "RANGE_INVALID",
        });
      }
      await expect(
        reader.readFramesInto(0, 2, new Float32Array(1)),
      ).rejects.toMatchObject({
        code: "AUDIO_READ_FAILED",
        reason: "RANGE_INVALID",
      });
    } finally {
      await reader.close();
    }
  });
});
