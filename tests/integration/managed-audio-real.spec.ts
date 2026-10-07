import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { Context } from "@deepseek-ai/cordis";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { openPcm16Wav } from "../../src/audio/wav-reader.js";
import {
  openManagedAudioStore,
  type ManagedAudioStore,
} from "../../src/storage/managed-audio-store.js";
import { createWave } from "../helpers/wav-fixture.js";

const suite = describe.skipIf(
  process.platform !== "darwin" || process.env.DSH_RUN_MANAGED_AUDIO_REAL !== "1",
);
const execFile = promisify(execFileCallback);
const roots: string[] = [];
let context: Context;

beforeAll(async () => {
  context = new Context();
  await context.plugin(LocalSubprocessRuntime);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  await context?.fiber.dispose();
});

async function createStore(): Promise<{ root: string; store: ManagedAudioStore }> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-real-audio-"));
  roots.push(root);
  return {
    root,
    store: await openManagedAudioStore({ dataRoot: root, subprocess: context.subprocess }),
  };
}

function createAlternatingStereoWave(): Buffer {
  const sampleRate = 44_100;
  const frameCount = sampleRate * 2;
  const samples = new Int16Array(frameCount * 2);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const frequency = frame < sampleRate ? 440 : 660;
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * frame) / sampleRate) * 16_000);
    samples[frame * 2 + (frame < sampleRate ? 0 : 1)] = sample;
  }
  return createWave(samples, { channels: 2, sampleRate });
}

function rms(samples: Float32Array): number {
  let sumSquares = 0;
  for (const sample of samples) sumSquares += sample * sample;
  return Math.sqrt(sumSquares / samples.length);
}

async function writeStereoFixture(
  directory: string,
  format: "wav" | "m4a" | "mp3",
): Promise<string> {
  if (format === "mp3") return resolve("tests/fixtures/audio/alternating-stereo.mp3");
  const wavePath = join(directory, "alternating-stereo.wav");
  await writeFile(wavePath, createAlternatingStereoWave());
  if (format === "wav") return wavePath;
  const outputPath = join(directory, "alternating-stereo.m4a");
  await execFile("/usr/bin/afconvert", [wavePath, "-f", "m4af", "-d", "aac ", outputPath]);
  return outputPath;
}

suite("真实 DSH 受管音频规范化", () => {
  it.each([
    ["WAV", "wav", "44444444-4444-4444-8444-444444444444"],
    ["M4A", "m4a", "55555555-5555-4555-8555-555555555555"],
    ["MP3", "mp3", "66666666-6666-4666-8666-666666666666"],
  ] as const)("将 $0 的全部输入声道混合进规范 WAV", async (_name, format, meetingId) => {
    const { root, store } = await createStore();
    const input = await store.openInput(await writeStereoFixture(root, format));
    expect(input.sourceFormat).toBe(format);
    await input.persist(meetingId);

    const normalized = await store.normalize(meetingId, format);
    const reader = await openPcm16Wav(normalized.audioPath);
    try {
      expect(rms(await reader.readFrames(4_000, 12_000))).toBeGreaterThan(0.08);
      expect(rms(await reader.readFrames(20_000, 28_000))).toBeGreaterThan(0.08);
    } finally {
      await reader.close();
    }
  }, 120_000);

  it("重跑从 stereo source 重建结构合法但陈旧的规范 WAV", async () => {
    const meetingId = "77777777-7777-4777-8777-777777777777";
    const { root, store } = await createStore();
    const input = await store.openInput(await writeStereoFixture(root, "wav"));
    await input.persist(meetingId);
    const audioPath = join(root, "meetings", meetingId, "audio.wav");
    await writeFile(audioPath, createWave(new Int16Array(32_000)));

    const normalized = await store.prepareRetranscription(meetingId, "wav", "import");
    const reader = await openPcm16Wav(normalized.audioPath);
    try {
      expect(rms(await reader.readFrames(4_000, 12_000))).toBeGreaterThan(0.08);
      expect(rms(await reader.readFrames(20_000, 28_000))).toBeGreaterThan(0.08);
    } finally {
      await reader.close();
    }
  }, 120_000);

});
