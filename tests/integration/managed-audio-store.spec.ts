import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
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
const OTHER_MEETING_ID = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
const noSubprocess: ManagedAudioSubprocess = {
  spawn() {
    throw new Error("subprocess should not start");
  },
};

async function createStore(
  availableBytes: bigint = 10n * 1024n * 1024n * 1024n,
): Promise<{ root: string; store: ManagedAudioStore }> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-audio-"));
  roots.push(root);
  const store = await openManagedAudioStore({
    dataRoot: root,
    subprocess: noSubprocess,
    capacityBytes: async () => availableBytes,
  });
  return { root: await realpath(root), store };
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

function id3Mp3Header(): Buffer {
  return Buffer.from([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xfb, 0x90, 0x64,
  ]);
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

it("从同一已验证 fd 落盘且不受输入路径替换影响", async () => {
  const { root, store } = await createStore();
  const inputPath = join(root, "伪装成.mp3");
  const original = createWave(new Int16Array(16_000));
  const replacement = createWave(new Int16Array(8_000));
  await writeFile(inputPath, original);
  const input = await store.openInput(inputPath);
  expect(input).toMatchObject({ sourceFormat: "wav", sourceSizeBytes: original.byteLength });

  await rename(inputPath, join(root, "original-moved.wav"));
  await writeFile(inputPath, replacement);
  const managed = await input.persist(MEETING_ID);
  await input.close();

  expect(managed).toEqual({
    sourceFormat: "wav",
    sourcePath: join(root, "meetings", MEETING_ID, "source.wav"),
    sourceSha256: createHash("sha256").update(original).digest("hex"),
    sourceSizeBytes: original.byteLength,
  });
  expect(await readFile(managed.sourcePath)).toEqual(original);
  expect((await stat(managed.sourcePath)).mode & 0o777).toBe(0o600);
  expect((await stat(join(root, "meetings", MEETING_ID))).mode & 0o777).toBe(0o700);
});

it("同一 inode 的内容在预检后变化时拒绝落盘", async () => {
  const { root, store } = await createStore();
  const inputPath = join(root, "mutable.wav");
  await writeFile(inputPath, createWave(new Int16Array(100)));
  const input = await store.openInput(inputPath);
  await writeFile(inputPath, createWave(new Int16Array(200)));

  await expect(input.persist(MEETING_ID)).rejects.toMatchObject({ code: "INVALID_PATH" });
  await expect(stat(join(root, "meetings", MEETING_ID, "source.wav"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(stat(join(root, "work", MEETING_ID, "source.tmp"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each([
  { name: "ISO BMFF/M4A", bytes: isoBmffHeader(), format: "m4a" as const },
  { name: "带 ID3 的 MP3", bytes: id3Mp3Header(), format: "mp3" as const },
  { name: "裸 MPEG frame MP3", bytes: Buffer.from([0xff, 0xfb, 0x90, 0x64]), format: "mp3" as const },
])("按 magic bytes 识别 $name", async ({ bytes, format }) => {
  const { root, store } = await createStore();
  const inputPath = join(root, "任意扩展名.bin");
  await writeFile(inputPath, bytes);

  const input = await store.openInput(inputPath);
  expect(input.sourceFormat).toBe(format);
  const managed = await input.persist(MEETING_ID);
  await input.close();
  expect(managed.sourcePath).toBe(join(root, "meetings", MEETING_ID, `source.${format}`));
});

it.each([
  { name: "不存在路径", expectedCode: "FILE_NOT_FOUND", create: async (_root: string) => "/missing/dsh-audio" },
  { name: "相对路径", expectedCode: "INVALID_PATH", create: async (_root: string) => "relative.wav" },
  {
    name: "目录",
    expectedCode: "INVALID_PATH",
    create: async (root: string) => {
      const path = join(root, "directory.wav");
      await mkdir(path);
      return path;
    },
  },
  {
    name: "软链接",
    expectedCode: "INVALID_PATH",
    create: async (root: string) => {
      const target = join(root, "target.wav");
      const path = join(root, "linked.wav");
      await writeFile(target, createWave(new Int16Array(10)));
      await symlink(target, path);
      return path;
    },
  },
  {
    name: "不可读文件",
    expectedCode: "INVALID_PATH",
    create: async (root: string) => {
      const path = join(root, "unreadable.wav");
      await writeFile(path, createWave(new Int16Array(10)));
      await chmod(path, 0o000);
      return path;
    },
  },
])("拒绝$name", async ({ expectedCode, create }) => {
  const { root, store } = await createStore();
  const inputPath = await create(root);

  await expect(store.openInput(inputPath)).rejects.toMatchObject({ code: expectedCode });
});

it.each([
  { name: "空文件", bytes: Buffer.alloc(0) },
  { name: "截断 RIFF", bytes: Buffer.from("RIFF", "ascii") },
  { name: "截断 ftyp", bytes: Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]) },
  { name: "非法 ID3 大小", bytes: Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0x80, 0, 0, 0]) },
])("拒绝$name的格式识别", async ({ bytes }) => {
  const { root, store } = await createStore();
  const inputPath = join(root, "invalid.audio");
  await writeFile(inputPath, bytes);

  await expect(store.openInput(inputPath)).rejects.toMatchObject({
    code: "UNSUPPORTED_AUDIO_FORMAT",
  });
});

it("在读取 magic bytes 前拒绝超过 500 MiB 的稀疏文件", async () => {
  const { root, store } = await createStore();
  const inputPath = join(root, "large.wav");
  await writeFile(inputPath, Buffer.from("RIFF"));
  await truncate(inputPath, 500 * 1024 * 1024 + 1);

  await expect(store.openInput(inputPath)).rejects.toMatchObject({
    code: "AUDIO_FILE_TOO_LARGE",
  });
});

it("磁盘预检不足时关闭输入且不创建会议目录", async () => {
  const { root, store } = await createStore(1n);
  const inputPath = join(root, "input.wav");
  await writeFile(inputPath, createWave(new Int16Array(10)));

  await expect(store.openInput(inputPath)).rejects.toMatchObject({
    code: "DISK_SPACE_INSUFFICIENT",
  });
  await expect(stat(join(root, "meetings", MEETING_ID))).rejects.toMatchObject({ code: "ENOENT" });
});

it("受管目录写入失败映射为稳定存储错误", async () => {
  const { root, store } = await createStore();
  const inputPath = join(root, "input.wav");
  await writeFile(inputPath, createWave(new Int16Array(10)));
  const input = await store.openInput(inputPath);
  const workRoot = join(root, "work");
  await chmod(workRoot, 0o500);
  try {
    await expect(input.persist(MEETING_ID)).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  } finally {
    await chmod(workRoot, 0o700);
  }
});

it("work 清理可重复执行且不删除会议音频", async () => {
  const { root, store } = await createStore();
  const work = join(root, "work", MEETING_ID);
  const meeting = join(root, "meetings", MEETING_ID);
  await mkdir(work, { recursive: true });
  await mkdir(meeting, { recursive: true });
  await writeFile(join(work, "stale.tmp"), "stale");
  await writeFile(join(meeting, "source.wav"), "source");

  await store.cleanupWork(MEETING_ID);
  await store.cleanupWork(MEETING_ID);

  await expect(stat(work)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(meeting, "source.wav"), "utf8")).toBe("source");
});

it("重跑从受管 source 重建，即使现有 audio.wav 结构合法", async () => {
  const { root, store } = await createStore();
  const inputPath = join(root, "input.wav");
  const sourceWave = createWave(new Int16Array(8_000));
  await writeFile(inputPath, sourceWave);
  const input = await store.openInput(inputPath);
  await input.persist(MEETING_ID);
  const audioPath = join(root, "meetings", MEETING_ID, "audio.wav");
  await writeFile(audioPath, createWave(new Int16Array(16_000)));

  await expect(store.assertManagedSource(MEETING_ID, "wav", "import")).resolves.toBeUndefined();
  await expect(store.prepareRetranscription(MEETING_ID, "wav", "import")).resolves.toEqual({
    audioPath,
    durationMs: 500,
    frameCount: 8_000,
  });
  expect(await readFile(audioPath)).toEqual(sourceWave);
});

it("重跑在 audio.wav 缺失时从受管 source 重新规范化", async () => {
  const { root, store } = await createStore();
  const inputPath = join(root, "input.wav");
  const wave = createWave(new Int16Array(8_000));
  await writeFile(inputPath, wave);
  const input = await store.openInput(inputPath);
  await input.persist(MEETING_ID);

  const result = await store.prepareRetranscription(MEETING_ID, "wav", "import");
  expect(result).toMatchObject({ durationMs: 500, frameCount: 8_000 });
  expect(await readFile(result.audioPath)).toEqual(wave);
});

it("重跑发现非 canonical audio.wav 时从受管 source 重新生成", async () => {
  const { root, store } = await createStore();
  const inputPath = join(root, "input.wav");
  const canonical = createWave(new Int16Array(8_000));
  await writeFile(inputPath, canonical);
  const input = await store.openInput(inputPath);
  await input.persist(MEETING_ID);
  const audioPath = join(root, "meetings", MEETING_ID, "audio.wav");
  await writeFile(audioPath, createWave(new Int16Array(4_000), { sampleRate: 8_000 }));

  await expect(store.prepareRetranscription(MEETING_ID, "wav", "import")).resolves.toMatchObject({
    audioPath,
    durationMs: 500,
    frameCount: 8_000,
  });
  expect(await readFile(audioPath)).toEqual(canonical);
});

it("重跑在固定受管 source 缺失时显式失败", async () => {
  const { store } = await createStore();
  await expect(store.assertManagedSource(MEETING_ID, "wav", "import"))
    .rejects.toMatchObject({ code: "INVALID_PATH" });
  await expect(store.prepareRetranscription(MEETING_ID, "wav", "import"))
    .rejects.toMatchObject({ code: "INVALID_PATH" });
});

it("删除只触碰固定 meeting/work 目录且不跟随软链接", async () => {
  const { root, store } = await createStore();
  const meeting = join(root, "meetings", MEETING_ID);
  const work = join(root, "work", MEETING_ID);
  const other = join(root, "meetings", OTHER_MEETING_ID);
  const external = join(root, "external.txt");
  await mkdir(meeting, { recursive: true });
  await mkdir(work, { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(join(meeting, "source.wav"), "source");
  await writeFile(join(meeting, "audio.wav"), "audio");
  await writeFile(join(work, "source.tmp"), "work");
  await writeFile(join(other, "audio.wav"), "other");
  await writeFile(external, "external");
  await symlink(external, join(meeting, "untrusted-link"));

  await expect(store.deleteMeeting(MEETING_ID)).resolves.toEqual({ freedBytes: 15 });
  await expect(stat(meeting)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(work)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(other, "audio.wav"), "utf8")).toBe("other");
  expect(await readFile(external, "utf8")).toBe("external");
});

it("启动清理整体重建 work 根且保留所有 meeting 音频", async () => {
  const { root, store } = await createStore();
  await mkdir(join(root, "work", MEETING_ID), { recursive: true });
  await writeFile(join(root, "work", MEETING_ID, "stale.tmp"), "stale");
  await mkdir(join(root, "meetings", MEETING_ID), { recursive: true });
  await writeFile(join(root, "meetings", MEETING_ID, "audio.wav"), "audio");

  await store.cleanupAllWork();
  await store.cleanupAllWork();

  expect((await stat(join(root, "work"))).isDirectory()).toBe(true);
  expect(await readFile(join(root, "meetings", MEETING_ID, "audio.wav"), "utf8")).toBe("audio");
});
