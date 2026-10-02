import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SubprocessHandle, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import { afterEach, expect, it, vi } from "vitest";

import { MAX_AUDIO_FRAMES, openPcm16Wav } from "../../src/audio/wav-reader.js";
import {
  openManagedAudioStore,
  type ManagedAudioStore,
  type ManagedAudioSubprocess,
} from "../../src/storage/managed-audio-store.js";
import { createWave, writeSparseWave } from "../helpers/wav-fixture.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];

interface FakeProcessOptions {
  readonly outcome?: { exitCode: number | null; signal: NodeJS.Signals | null };
  readonly run?: (spec: SubprocessSpawnSpec) => Promise<void>;
  readonly spawnFailure?: Error;
  readonly treeExited?: boolean;
}

function fakeSubprocess(options: FakeProcessOptions = {}): {
  readonly spawn: ReturnType<typeof vi.fn<ManagedAudioSubprocess["spawn"]>>;
  readonly subprocess: ManagedAudioSubprocess;
} {
  const spawn = vi.fn<ManagedAudioSubprocess["spawn"]>((spec) => {
    const done = (async () => {
      if (options.spawnFailure !== undefined) throw options.spawnFailure;
      await options.run?.(spec);
      return options.outcome ?? { exitCode: 0, signal: null };
    })();
    return {
      control: undefined,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: "diagnostic", nextOffset: 10, lossy: false }) },
      },
      done,
      terminate: vi.fn(),
      waitForExit: vi.fn(async () => options.treeExited ?? true),
    } satisfies SubprocessHandle;
  });
  return { spawn, subprocess: { spawn } };
}

async function createStore(
  subprocess: ManagedAudioSubprocess,
  conversionDeadline?: () => AbortSignal,
): Promise<{ root: string; store: ManagedAudioStore }> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-normalize-"));
  roots.push(root);
  const options = {
    dataRoot: root,
    subprocess,
    capacityBytes: async () => 10n * 1024n * 1024n * 1024n,
    ...(conversionDeadline === undefined ? {} : { conversionDeadline }),
  };
  return { root: await realpath(root), store: await openManagedAudioStore(options) };
}

async function persist(
  store: ManagedAudioStore,
  root: string,
  bytes: Buffer,
  fileName: string,
): Promise<"wav" | "m4a" | "mp3"> {
  const inputPath = join(root, fileName);
  await writeFile(inputPath, bytes);
  const input = await store.openInput(inputPath);
  await input.persist(MEETING_ID);
  return input.sourceFormat;
}

function isoBmffHeader(): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(24, 0);
  header.write("ftyp", 4, "ascii");
  header.write("M4A ", 8, "ascii");
  header.write("isom", 16, "ascii");
  header.write("mp42", 20, "ascii");
  return header;
}

function outputPath(spec: SubprocessSpawnSpec): string {
  const value = spec.argv.at(-1);
  if (value === undefined) throw new Error("missing output path");
  return value;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

it("canonical WAV 不启动子进程并原子形成 audio.wav", async () => {
  const process = fakeSubprocess();
  const { root, store } = await createStore(process.subprocess);
  const wave = createWave(new Int16Array(16_000));
  await persist(store, root, wave, "input.wav");

  const result = await store.normalize(MEETING_ID, "wav");

  expect(process.spawn).not.toHaveBeenCalled();
  expect(result).toEqual({
    audioPath: join(root, "meetings", MEETING_ID, "audio.wav"),
    durationMs: 1_000,
    frameCount: 16_000,
  });
  expect(await readFile(result.audioPath)).toEqual(wave);
  expect((await stat(result.audioPath)).mode & 0o777).toBe(0o600);
});

it("已取消的 canonical WAV 不继续复制", async () => {
  const process = fakeSubprocess();
  const { root, store } = await createStore(process.subprocess);
  await persist(store, root, createWave(new Int16Array(160)), "input.wav");

  await expect(store.normalize(MEETING_ID, "wav", AbortSignal.abort())).rejects.toMatchObject({
    code: "CANCELLED_BY_USER",
  });
  await expect(stat(join(root, "meetings", MEETING_ID, "audio.wav"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(process.spawn).not.toHaveBeenCalled();
});

it.each([
  {
    name: "非 canonical WAV",
    bytes: createWave(new Int16Array(8_000), { sampleRate: 8_000 }),
    fileName: "input.wav",
    format: "wav" as const,
  },
  { name: "M4A", bytes: isoBmffHeader(), fileName: "input.m4a", format: "m4a" as const },
  {
    name: "MP3",
    bytes: Buffer.from([0xff, 0xfb, 0x90, 0x64]),
    fileName: "input.mp3",
    format: "mp3" as const,
  },
])("$name 通过 DSH subprocess 规范化", async ({ bytes, fileName, format }) => {
  const process = fakeSubprocess({
    run: async (spec) => writeFile(outputPath(spec), createWave(new Int16Array(16_000))),
  });
  const { root, store } = await createStore(process.subprocess);
  await persist(store, root, bytes, fileName);

  const result = await store.normalize(MEETING_ID, format);

  expect(result).toMatchObject({ durationMs: 1_000, frameCount: 16_000 });
  const spec = process.spawn.mock.calls[0]![0];
  expect(spec.argv).toEqual([
    "/usr/bin/afconvert",
    join(root, "meetings", MEETING_ID, `source.${format}`),
    "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", "--mix",
    join(root, "work", MEETING_ID, "audio.tmp.wav"),
  ]);
  expect(spec).toMatchObject({
    cwd: join(root, "work", MEETING_ID),
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: 1_024 },
      stderr: { maxBytes: 8_192 },
    },
    graceMs: 2_000,
    env: { LANG: "C", LC_ALL: "C" },
  });
});

it("损坏 WAV 不尝试用转换器掩盖", async () => {
  const process = fakeSubprocess();
  const { root, store } = await createStore(process.subprocess);
  const corrupt = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]);
  await persist(store, root, corrupt, "broken.wav");

  await expect(store.normalize(MEETING_ID, "wav")).rejects.toMatchObject({
    code: "AUDIO_DECODE_FAILED",
  });
  expect(process.spawn).not.toHaveBeenCalled();
});

it("受管 source 缺失时返回存储错误且不启动转换器", async () => {
  const process = fakeSubprocess();
  const { store } = await createStore(process.subprocess);

  await expect(store.normalize(MEETING_ID, "m4a")).rejects.toMatchObject({
    code: "STORAGE_FAILURE",
  });
  expect(process.spawn).not.toHaveBeenCalled();
});

it("afconvert 非零退出映射为解码失败并删除临时输出", async () => {
  const process = fakeSubprocess({
    outcome: { exitCode: 1, signal: null },
    run: async (spec) => writeFile(outputPath(spec), "partial"),
  });
  const { root, store } = await createStore(process.subprocess);
  await persist(store, root, isoBmffHeader(), "broken.m4a");

  await expect(store.normalize(MEETING_ID, "m4a")).rejects.toMatchObject({
    code: "AUDIO_DECODE_FAILED",
  });
  await expect(stat(join(root, "work", MEETING_ID, "audio.tmp.wav"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("afconvert spawn 失败映射为引擎失败", async () => {
  const process = fakeSubprocess({ spawnFailure: new Error("spawn failed") });
  const { root, store } = await createStore(process.subprocess);
  await persist(store, root, isoBmffHeader(), "input.m4a");

  await expect(store.normalize(MEETING_ID, "m4a")).rejects.toMatchObject({
    code: "ENGINE_FAILURE",
  });
});

it("afconvert 超时映射为引擎失败", async () => {
  const process = fakeSubprocess({ outcome: { exitCode: null, signal: "SIGTERM" } });
  const deadline = () => AbortSignal.abort(new DOMException("expired", "TimeoutError"));
  const { root, store } = await createStore(process.subprocess, deadline);
  await persist(store, root, isoBmffHeader(), "input.m4a");

  await expect(store.normalize(MEETING_ID, "m4a")).rejects.toMatchObject({
    code: "ENGINE_FAILURE",
  });
});

it("任务取消不被误报为解码或引擎失败", async () => {
  const process = fakeSubprocess();
  const { root, store } = await createStore(process.subprocess);
  await persist(store, root, isoBmffHeader(), "input.m4a");

  await expect(store.normalize(MEETING_ID, "m4a", AbortSignal.abort())).rejects.toMatchObject({
    code: "CANCELLED_BY_USER",
  });
  expect(process.spawn).not.toHaveBeenCalled();
});

it("afconvert 成功但输出非法时映射为引擎失败", async () => {
  const process = fakeSubprocess({
    run: async (spec) => writeFile(outputPath(spec), "not a wave"),
  });
  const { root, store } = await createStore(process.subprocess);
  await persist(store, root, isoBmffHeader(), "input.m4a");

  await expect(store.normalize(MEETING_ID, "m4a")).rejects.toMatchObject({
    code: "ENGINE_FAILURE",
  });
});

it("规范化输出超过四小时即拒绝且不替换旧 audio.wav", async () => {
  const process = fakeSubprocess({
    run: async (spec) => writeSparseWave(outputPath(spec), MAX_AUDIO_FRAMES + 1),
  });
  const { root, store } = await createStore(process.subprocess);
  await persist(store, root, isoBmffHeader(), "input.m4a");
  const meetingDirectory = join(root, "meetings", MEETING_ID);
  await mkdir(meetingDirectory, { recursive: true });
  await writeFile(join(meetingDirectory, "audio.wav"), "old audio");

  await expect(store.normalize(MEETING_ID, "m4a")).rejects.toMatchObject({
    code: "AUDIO_TOO_LONG",
  });
  expect(await readFile(join(meetingDirectory, "audio.wav"), "utf8")).toBe("old audio");
});

it("转换后的 WAV 可由正式 reader 打开", async () => {
  const process = fakeSubprocess({
    run: async (spec) => writeFile(outputPath(spec), createWave(new Int16Array(160))),
  });
  const { root, store } = await createStore(process.subprocess);
  await persist(store, root, isoBmffHeader(), "input.m4a");
  const result = await store.normalize(MEETING_ID, "m4a");

  const reader = await openPcm16Wav(result.audioPath);
  expect(reader.metadata).toMatchObject({ sampleRate: 16_000, channels: 1, bitDepth: 16 });
  await reader.close();
});
