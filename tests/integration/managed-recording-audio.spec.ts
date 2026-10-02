import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  openManagedAudioStore,
  type ManagedAudioStore,
  type ManagedAudioSubprocess,
} from "../../src/storage/managed-audio-store.js";
import { createWave } from "../helpers/wav-fixture.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
const noSubprocess: ManagedAudioSubprocess = {
  spawn() {
    throw new Error("subprocess should not start");
  },
};

async function createStore(): Promise<{ root: string; store: ManagedAudioStore }> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-recording-audio-"));
  roots.push(root);
  const store = await openManagedAudioStore({
    dataRoot: root,
    subprocess: noSubprocess,
    capacityBytes: async () => 10n * 1024n * 1024n * 1024n,
  });
  return { root: await realpath(root), store };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

it("为一场录音创建 owner-only 的会议、双轨 chunks 与 work 目录", async () => {
  const { root, store } = await createStore();

  const layout = await store.prepareRecording(MEETING_ID);

  expect(layout).toEqual({
    meetingDirectory: join(root, "meetings", MEETING_ID),
    recordingDirectory: join(root, "meetings", MEETING_ID, "recording"),
    workRecordingDirectory: join(root, "work", MEETING_ID, "recording"),
  });
  for (const directory of [
    layout.meetingDirectory,
    layout.recordingDirectory,
    join(layout.recordingDirectory, "mic", "chunks"),
    join(layout.recordingDirectory, "system", "chunks"),
    layout.workRecordingDirectory,
  ]) {
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  }
});

function repeated(value: number): Int16Array {
  return new Int16Array(16).fill(value);
}

function pcm16Samples(wave: Buffer): number[] {
  const samples: number[] = [];
  for (let offset = 44; offset < wave.byteLength; offset += 2) {
    samples.push(wave.readInt16LE(offset));
  }
  return samples;
}

it("按共同时间轴从双轨 chunks 重建原轨与不衰减的规范 audio.wav", async () => {
  const { root, store } = await createStore();
  const layout = await store.prepareRecording(MEETING_ID);
  const micChunks = join(layout.recordingDirectory, "mic", "chunks");
  const systemChunks = join(layout.recordingDirectory, "system", "chunks");
  await writeFile(join(micChunks, "1000000-1001000.wav"), createWave(repeated(1_000)));
  await writeFile(join(micChunks, "1001000-1002000.wav"), createWave(repeated(2_000)));
  await writeFile(join(systemChunks, "1000500-1001500.wav"), createWave(repeated(3_000)));

  const recovered = await store.recoverRecording(MEETING_ID);

  const audioBytes = await readFile(recovered.sourcePath);
  expect(recovered).toEqual({
    durationMs: 2,
    frameCount: 32,
    sourceFormat: "wav",
    sourcePath: join(root, "meetings", MEETING_ID, "audio.wav"),
    sourceSha256: createHash("sha256").update(audioBytes).digest("hex"),
    sourceSizeBytes: audioBytes.byteLength,
    tracks: ["mic", "system"],
  });
  expect(pcm16Samples(audioBytes)).toEqual([
    ...new Array(8).fill(1_000),
    ...new Array(8).fill(2_000),
    ...new Array(8).fill(2_500),
    ...new Array(8).fill(2_000),
  ]);
  await expect(stat(join(layout.recordingDirectory, "mic.wav"))).resolves.toBeDefined();
  await expect(stat(join(layout.recordingDirectory, "system.wav"))).resolves.toBeDefined();
  await expect(stat(micChunks)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(systemChunks)).rejects.toMatchObject({ code: "ENOENT" });
});

it("坏 chunk 使恢复显式失败且不覆盖既有 audio 或删除好 chunk", async () => {
  const { store } = await createStore();
  const layout = await store.prepareRecording(MEETING_ID);
  const micChunk = join(layout.recordingDirectory, "mic", "chunks", "1000000-1001000.wav");
  const badChunk = join(layout.recordingDirectory, "system", "chunks", "1000000-1001000.wav");
  const existingAudio = createWave(repeated(777));
  const audioPath = join(layout.meetingDirectory, "audio.wav");
  await writeFile(micChunk, createWave(repeated(1_000)));
  await writeFile(badChunk, Buffer.from("truncated"));
  await writeFile(audioPath, existingAudio);

  await expect(store.recoverRecording(MEETING_ID)).rejects.toMatchObject({
    code: "AUDIO_RECOVERY_FAILED",
  });
  expect(await readFile(audioPath)).toEqual(existingAudio);
  await expect(stat(micChunk)).resolves.toBeDefined();
  await expect(stat(badChunk)).resolves.toBeDefined();
});

it("超出可信捕获时长的分块拒绝恢复并完整保留原轨", async () => {
  const { store } = await createStore();
  const layout = await store.prepareRecording(MEETING_ID);
  const chunkPath = join(layout.recordingDirectory, "system", "chunks", "1000000-1003000.wav");
  const original = createWave(new Int16Array(48).fill(1_000));
  await writeFile(chunkPath, original);

  await expect(store.recoverRecording(MEETING_ID, 2)).rejects.toMatchObject({
    code: "AUDIO_RECOVERY_FAILED",
  });
  expect(await readFile(chunkPath)).toEqual(original);
  await expect(stat(join(layout.meetingDirectory, "audio.wav")))
    .rejects.toMatchObject({ code: "ENOENT" });
});

it("聚合音频已完整提升时忽略并清理崩溃遗留的坏 chunks", async () => {
  const { store } = await createStore();
  const layout = await store.prepareRecording(MEETING_ID);
  await writeFile(
    join(layout.recordingDirectory, "mic", "chunks", "1000000-1001000.wav"),
    createWave(repeated(1_000)),
  );
  await writeFile(
    join(layout.recordingDirectory, "system", "chunks", "1000000-1001000.wav"),
    createWave(repeated(2_000)),
  );
  const promoted = await store.recoverRecording(MEETING_ID);
  const promotedBytes = await readFile(promoted.sourcePath);
  const micChunks = join(layout.recordingDirectory, "mic", "chunks");
  const systemChunks = join(layout.recordingDirectory, "system", "chunks");
  await mkdir(micChunks, { recursive: true });
  await mkdir(systemChunks, { recursive: true });
  await writeFile(join(micChunks, "1000000-1000500.wav"), Buffer.from("truncated"));
  await writeFile(join(systemChunks, "1000500-1001000.wav"), Buffer.from("truncated"));

  await expect(store.recoverRecording(MEETING_ID)).resolves.toEqual(promoted);
  expect(await readFile(promoted.sourcePath)).toEqual(promotedBytes);
  await expect(stat(micChunks)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(systemChunks)).rejects.toMatchObject({ code: "ENOENT" });
});

it("聚合音频也必须满足捕获时长边界后才可清理遗留分块", async () => {
  const { store } = await createStore();
  const layout = await store.prepareRecording(MEETING_ID);
  const chunkPath = join(layout.recordingDirectory, "system", "chunks", "1000000-1003000.wav");
  const original = createWave(new Int16Array(48).fill(1_000));
  await writeFile(chunkPath, original);
  await writeFile(join(layout.recordingDirectory, "system.wav"), original);
  await writeFile(join(layout.meetingDirectory, "audio.wav"), original);

  await expect(store.recoverRecording(MEETING_ID, 2)).rejects.toMatchObject({
    code: "AUDIO_RECOVERY_FAILED",
  });
  expect(await readFile(chunkPath)).toEqual(original);
  await expect(store.recoverRecording(MEETING_ID, 3)).resolves.toMatchObject({ durationMs: 3 });
  await expect(stat(chunkPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("录音规范 audio.wav 是重转写来源且单轨样本不衰减", async () => {
  const { store } = await createStore();
  const layout = await store.prepareRecording(MEETING_ID);
  await writeFile(
    join(layout.recordingDirectory, "mic", "chunks", "1000000-1001000.wav"),
    createWave(repeated(-2_000)),
  );
  const recovered = await store.recoverRecording(MEETING_ID);

  await expect(store.assertManagedSource(MEETING_ID, "wav", "recording"))
    .resolves.toBeUndefined();
  await expect(store.prepareRetranscription(MEETING_ID, "wav", "recording"))
    .resolves.toEqual({
      audioPath: recovered.sourcePath,
      durationMs: 1,
      frameCount: 16,
    });
  expect(pcm16Samples(await readFile(recovered.sourcePath))).toEqual(new Array(16).fill(-2_000));
});

it("删除录音会议递归计入并移除规范音频与聚合原轨", async () => {
  const { store } = await createStore();
  const layout = await store.prepareRecording(MEETING_ID);
  const chunkPath = join(
    layout.recordingDirectory,
    "mic",
    "chunks",
    "1000000-1001000.wav",
  );
  await writeFile(chunkPath, createWave(repeated(1_000)));
  const recovered = await store.recoverRecording(MEETING_ID);
  const expectedBytes = (await stat(join(layout.recordingDirectory, "mic.wav"))).size
    + recovered.sourceSizeBytes;

  await expect(store.deleteMeeting(MEETING_ID)).resolves.toEqual({
    freedBytes: expectedBytes,
  });
  await expect(stat(layout.meetingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(layout.workRecordingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});
