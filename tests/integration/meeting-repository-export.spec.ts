import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, expect, it } from "vitest";

import type { MeetingRepository } from "../../src/storage/meeting-repository.js";
import { createTranscriptProjection } from "../../src/transcript-projection/transcript-projection.js";
import {
  commitMeeting,
  createTemporaryMeetingRepository,
  meetingId,
  retranscribeRunId,
} from "../helpers/meeting-repository-fixture.js";

const roots: string[] = [];
const repositories: MeetingRepository[] = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

it("在文件 I/O 前区分未提交与空转写", async () => {
  const uncommitted = await createTemporaryMeetingRepository();
  roots.push(uncommitted.root);
  repositories.push(uncommitted.repository);
  uncommitted.repository.createImport({
    meetingId: meetingId(1),
    title: "处理中",
    sourceName: "processing.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1_024,
    runId: "10000000-0000-4000-8000-000000000001",
    nowMs: 1_000,
  });
  const pendingProjection = createTranscriptProjection(
    uncommitted.repository,
    () => null,
    { dataRoot: uncommitted.root, now: () => 2_000 },
  );

  await expect(pendingProjection.exportCommittedTranscript({
    meetingId: meetingId(1),
    format: "md",
    outputPath: "/path/that/must/not/be-touched.md",
  })).rejects.toMatchObject({ code: "TRANSCRIPT_NOT_COMMITTED" });

  const empty = await createTemporaryMeetingRepository();
  roots.push(empty.root);
  repositories.push(empty.repository);
  empty.repository.createImport({
    meetingId: meetingId(2),
    title: "空会议",
    sourceName: "empty.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1_024,
    runId: "10000000-0000-4000-8000-000000000002",
    nowMs: 3_000,
  });
  empty.repository.commitTranscript({
    meetingId: meetingId(2),
    runId: "10000000-0000-4000-8000-000000000002",
    baseVersion: 0,
    resultStatus: "empty",
    resultReason: "silent",
    durationMs: 1_000,
    engineFingerprint: "a".repeat(64),
    segments: [],
    nowMs: 3_001,
  });
  const emptyProjection = createTranscriptProjection(
    empty.repository,
    () => null,
    { dataRoot: empty.root, now: () => 4_000 },
  );

  await expect(emptyProjection.exportCommittedTranscript({
    meetingId: meetingId(2),
    format: "txt",
    outputPath: "/path/that/must/not/be-touched.txt",
  })).rejects.toMatchObject({ code: "TRANSCRIPT_EMPTY" });
});

it("在一个只读事务中物化完整 committed Meeting 版本", async () => {
  const temporary = await createTemporaryMeetingRepository();
  roots.push(temporary.root);
  repositories.push(temporary.repository);
  commitMeeting(temporary.repository, 1, {
    title: "导出会议",
    texts: ["第一段。", "第二段。"],
  });

  const snapshot = temporary.repository.getCommittedTranscriptSnapshot(meetingId(1));

  expect(snapshot.meeting).toMatchObject({
    meetingId: meetingId(1),
    committedStatus: "completed",
    transcriptVersion: 1,
    durationMs: 2_000,
  });
  expect(snapshot.segments).toEqual([
    { seq: 0, startMs: 0, endMs: 500, speakerLabel: "Speaker A", text: "第一段。" },
    { seq: 1, startMs: 1_000, endMs: 1_500, speakerLabel: "Speaker B", text: "第二段。" },
  ]);
});

it("把固定版本原子发布到 data root 外并只返回 content-free 回执", async () => {
  const temporary = await createTemporaryMeetingRepository();
  const outputRoot = await mkdtemp(join(tmpdir(), "dsh-asr-export-output-"));
  roots.push(temporary.root, outputRoot);
  repositories.push(temporary.repository);
  commitMeeting(temporary.repository, 1, {
    title: "导出会议",
    texts: ["第一段。", "第二段。"],
  });
  const projection = createTranscriptProjection(
    temporary.repository,
    () => null,
    { dataRoot: temporary.root, now: () => Date.parse("2026-09-01T02:03:04.005Z") },
  );
  const outputPath = join(outputRoot, "transcript.md");

  const receipt = await projection.exportCommittedTranscript({
    meetingId: meetingId(1),
    format: "md",
    outputPath,
  });

  const bytes = await readFile(outputPath);
  expect(receipt).toEqual({
    meetingId: meetingId(1),
    transcriptVersion: 1,
    outputPath,
    format: "md",
    segmentCount: 2,
    durationMs: 2_000,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    overwritten: false,
  });
  expect(bytes.toString("utf8")).toContain('exported_at: "2026-09-01T02:03:04.005Z"');
  expect(bytes.toString("utf8")).toContain("第一段。");
  expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
  expect(await readdir(outputRoot)).toEqual(["transcript.md"]);
});

it("字幕格式强制保留时间戳", async () => {
  const temporary = await createTemporaryMeetingRepository();
  const outputRoot = await mkdtemp(join(tmpdir(), "dsh-asr-export-output-"));
  roots.push(temporary.root, outputRoot);
  repositories.push(temporary.repository);
  commitMeeting(temporary.repository, 1, { texts: ["第一段。"] });
  const projection = createTranscriptProjection(
    temporary.repository,
    () => null,
    { dataRoot: temporary.root, now: () => 2_000 },
  );

  await expect(projection.exportCommittedTranscript({
    meetingId: meetingId(1),
    format: "srt",
    outputPath: join(outputRoot, "transcript.srt"),
    includeTimestamps: false,
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(await readdir(outputRoot)).toEqual([]);
});

it("默认保护已有文件，显式覆盖时才原子替换普通文件", async () => {
  const temporary = await createTemporaryMeetingRepository();
  const outputRoot = await mkdtemp(join(tmpdir(), "dsh-asr-export-output-"));
  roots.push(temporary.root, outputRoot);
  repositories.push(temporary.repository);
  commitMeeting(temporary.repository, 1, { texts: ["新原稿。"] });
  const projection = createTranscriptProjection(
    temporary.repository,
    () => null,
    { dataRoot: temporary.root, now: () => 2_000 },
  );
  const outputPath = join(outputRoot, "transcript.txt");
  await writeFile(outputPath, "用户原文件", { mode: 0o640 });

  await expect(projection.exportCommittedTranscript({
    meetingId: meetingId(1),
    format: "txt",
    outputPath,
  })).rejects.toMatchObject({ code: "EXPORT_TARGET_EXISTS" });
  expect(await readFile(outputPath, "utf8")).toBe("用户原文件");

  await expect(projection.exportCommittedTranscript({
    meetingId: meetingId(1),
    format: "txt",
    outputPath,
    overwrite: true,
  })).resolves.toMatchObject({ outputPath, overwritten: true });
  expect(await readFile(outputPath, "utf8")).toContain("新原稿。");
  expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
  expect(await readdir(outputRoot)).toEqual(["transcript.txt"]);
});

it("拒绝越界、错扩展名、失效父目录、symlink 与非普通目标", async () => {
  const temporary = await createTemporaryMeetingRepository();
  const outputRoot = await mkdtemp(join(tmpdir(), "dsh-asr-export-output-"));
  roots.push(temporary.root, outputRoot);
  repositories.push(temporary.repository);
  commitMeeting(temporary.repository, 1, { texts: ["安全原稿。"] });
  const projection = createTranscriptProjection(
    temporary.repository,
    () => null,
    { dataRoot: temporary.root, now: () => 2_000 },
  );
  const realTarget = join(outputRoot, "real.md");
  const linkedTarget = join(outputRoot, "linked.md");
  const directoryTarget = join(outputRoot, "directory.md");
  const managedLink = join(outputRoot, "managed");
  await writeFile(realTarget, "外部文件");
  await symlink(realTarget, linkedTarget);
  await mkdir(directoryTarget);
  await symlink(temporary.root, managedLink, "dir");

  for (const outputPath of [
    "relative.md",
    join(outputRoot, "nul\0.md"),
    `/${"a".repeat(4_093)}.md`,
    join(outputRoot, `${"a".repeat(300)}.md`),
    `${join(outputRoot, "trailing.md")}${sep}`,
    join(outputRoot, "wrong.txt"),
    join(outputRoot, "missing", "transcript.md"),
    join(temporary.root, "inside.md"),
    linkedTarget,
    directoryTarget,
    join(managedLink, "through-link.md"),
  ]) {
    await expect(projection.exportCommittedTranscript({
      meetingId: meetingId(1),
      format: "md",
      outputPath,
      overwrite: true,
    }), outputPath).rejects.toMatchObject({ code: "EXPORT_PATH_INVALID" });
  }

  expect(await readFile(realTarget, "utf8")).toBe("外部文件");
  expect((await readdir(outputRoot)).some((name) => name.startsWith(".dsh-asr-export-")))
    .toBe(false);
});

it("取消与目录拒写时不留下半成品或临时文件", async () => {
  const temporary = await createTemporaryMeetingRepository();
  const outputRoot = await mkdtemp(join(tmpdir(), "dsh-asr-export-output-"));
  const deniedRoot = join(outputRoot, "denied");
  const sealedRoot = join(outputRoot, "sealed");
  await mkdir(deniedRoot, { mode: 0o500 });
  await mkdir(sealedRoot, { mode: 0o000 });
  roots.push(temporary.root, outputRoot);
  repositories.push(temporary.repository);
  commitMeeting(temporary.repository, 1, { texts: ["不会残留。"] });
  const projection = createTranscriptProjection(
    temporary.repository,
    () => null,
    { dataRoot: temporary.root, now: () => 2_000 },
  );
  const controller = new AbortController();
  const cancelledPath = join(outputRoot, "cancelled.md");
  const pending = projection.exportCommittedTranscript({
    meetingId: meetingId(1),
    format: "md",
    outputPath: cancelledPath,
    signal: controller.signal,
  });
  queueMicrotask(() => controller.abort());

  await expect(pending).rejects.toMatchObject({ code: "CANCELLED_BY_USER" });
  expect((await readdir(outputRoot)).sort()).toEqual(["denied", "sealed"]);
  try {
    await expect(projection.exportCommittedTranscript({
      meetingId: meetingId(1),
      format: "md",
      outputPath: join(deniedRoot, "transcript.md"),
    })).rejects.toMatchObject({ code: "EXPORT_PERMISSION_DENIED" });
    expect(await readdir(deniedRoot)).toEqual([]);

    await expect(projection.exportCommittedTranscript({
      meetingId: meetingId(1),
      format: "md",
      outputPath: join(sealedRoot, "transcript.md"),
    })).rejects.toMatchObject({ code: "EXPORT_PERMISSION_DENIED" });
  } finally {
    await Promise.all([chmod(deniedRoot, 0o700), chmod(sealedRoot, 0o700)]);
  }
});

it("并发 no-replace 竞争只有一个完整导出获胜", async () => {
  const temporary = await createTemporaryMeetingRepository();
  const outputRoot = await mkdtemp(join(tmpdir(), "dsh-asr-export-output-"));
  roots.push(temporary.root, outputRoot);
  repositories.push(temporary.repository);
  commitMeeting(temporary.repository, 1, { texts: ["唯一完整原稿。"] });
  const projection = createTranscriptProjection(
    temporary.repository,
    () => null,
    { dataRoot: temporary.root, now: () => 2_000 },
  );
  const outputPath = join(outputRoot, "transcript.md");

  const results = await Promise.allSettled([
    projection.exportCommittedTranscript({ meetingId: meetingId(1), format: "md", outputPath }),
    projection.exportCommittedTranscript({ meetingId: meetingId(1), format: "md", outputPath }),
  ]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const failures = results.filter((result) => result.status === "rejected");
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ reason: { code: "EXPORT_TARGET_EXISTS" } });
  expect(await readFile(outputPath, "utf8")).toContain("唯一完整原稿。");
  expect(await readdir(outputRoot)).toEqual(["transcript.md"]);
});

it("快照释放事务后允许新版本提交且本次仍只导出旧完整版本", async () => {
  const temporary = await createTemporaryMeetingRepository();
  const outputRoot = await mkdtemp(join(tmpdir(), "dsh-asr-export-output-"));
  roots.push(temporary.root, outputRoot);
  repositories.push(temporary.repository);
  commitMeeting(temporary.repository, 1, { texts: ["版本一原稿。"] });
  let versionAdvanced = false;
  const projection = createTranscriptProjection(
    temporary.repository,
    () => null,
    {
      dataRoot: temporary.root,
      now: () => {
        if (!versionAdvanced) {
          temporary.repository.beginRetranscription({
            meetingId: meetingId(1),
            expectedVersion: 1,
            runId: retranscribeRunId(1),
            nowMs: 3_000,
          });
          temporary.repository.commitTranscript({
            meetingId: meetingId(1),
            runId: retranscribeRunId(1),
            baseVersion: 1,
            resultStatus: "completed",
            resultReason: null,
            durationMs: 1_000,
            engineFingerprint: "b".repeat(64),
            segments: [{
              seq: 0,
              startMs: 0,
              endMs: 500,
              speakerLabel: "Speaker B",
              text: "版本二原稿。",
            }],
            nowMs: 3_001,
          });
          versionAdvanced = true;
        }
        return 4_000;
      },
    },
  );
  const outputPath = join(outputRoot, "transcript.txt");

  const receipt = await projection.exportCommittedTranscript({
    meetingId: meetingId(1),
    format: "txt",
    outputPath,
  });

  expect(receipt.transcriptVersion).toBe(1);
  expect(temporary.repository.getMeeting(meetingId(1))?.transcriptVersion).toBe(2);
  const text = await readFile(outputPath, "utf8");
  expect(text).toContain("版本一原稿。");
  expect(text).not.toContain("版本二原稿。");
});
