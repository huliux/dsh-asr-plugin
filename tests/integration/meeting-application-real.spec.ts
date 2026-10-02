import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { JobId } from "@deepseek-ai/dsh-jobs";
import LocalJobRegistry from "@deepseek-ai/dsh-jobs-local";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MeetingApplication } from "../../src/application/meeting-application.js";
import { fingerprintAssetManifest } from "../../src/assets/verify-assets.js";
import { openManagedAudioStore } from "../../src/storage/managed-audio-store.js";
import {
  openMeetingRepository,
  type MeetingRepository,
} from "../../src/storage/meeting-repository.js";
import { createDshWorkerSpawner } from "../../src/worker/dsh-spawner.js";
import { createWorkerEnvironment } from "../../src/worker/launch.js";
import { WorkerClient } from "../../src/worker/worker-client.js";
import type { WorkerKind } from "../../src/worker/types.js";

const suite = describe.skipIf(process.env.DSH_RUN_P1A_APPLICATION_REAL !== "1");
const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const manifestPath = resolve("dist/assets/manifest.json");
let context: Context;
let application: MeetingApplication | undefined;
let repository: MeetingRepository;
let root: string;

function worker(kind: WorkerKind, fingerprint: string): WorkerClient {
  return new WorkerClient({
    kind,
    expectedFingerprint: fingerprint,
    spawner: createDshWorkerSpawner(context.subprocess),
    launch: {
      argv: [
        process.execPath,
        resolve(`dist/worker/${kind}-entry.js`),
        resolve("data/assets"),
        resolve("data/assets"),
        manifestPath,
        join(root, "meetings"),
      ],
      cwd: resolve("dist/worker"),
      environment: createWorkerEnvironment(),
      graceMs: 2_000,
    },
    readyTimeoutMs: 180_000,
    runDeadlineMs: 600_000,
    terminationTimeoutMs: 15_000,
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-asr-application-real-"));
  context = new Context();
  await context.plugin(LocalJobRegistry);
  await context.plugin(LocalSubprocessRuntime);
  context.jobs.attachController("meeting-real-test");
  repository = openMeetingRepository(join(root, "meetings.sqlite3"));
});

afterAll(async () => {
  if (application === undefined) repository?.close();
  else await application.shutdown();
  await context?.fiber.dispose();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

suite("真实 DSH 导入主链", () => {
  it("从受管 WAV 经双 Worker 提交为可读取会议", async () => {
    const fingerprint = await fingerprintAssetManifest(manifestPath);
    const audioStore = await openManagedAudioStore({
      dataRoot: root,
      subprocess: context.subprocess,
    });
    const ids = [MEETING_ID, RUN_ID];
    let idIndex = 0;
    application = new MeetingApplication({
      asr: worker("asr", fingerprint),
      audioStore,
      dataRoot: root,
      diarization: worker("diarization", fingerprint),
      engineFingerprint: fingerprint,
      generateId: () => ids[idIndex++]!,
      jobs: context.jobs,
      repository,
    });

    const started = await application.startImport({
      path: resolve("data/p0-wav/worker-smoke.wav"),
      title: "真实 Worker smoke",
    });
    expect(started).toEqual({ meetingId: MEETING_ID, jobId: "meeting-1", status: "processing" });
    const terminal = await context.jobs.wait(JobId(started.jobId), 170_000);
    expect(terminal.status).toBe("completed");

    const page = repository.getMeetingPage({ meetingId: MEETING_ID });
    expect(["completed", "partial"]).toContain(page.meeting.status);
    expect(page.meeting).toMatchObject({ transcriptVersion: 1 });
    expect(page.meeting.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(page.transcript.available).toBe(true);
    expect(page.transcript.segments.length).toBeGreaterThan(0);
    expect(application.activeJobIdFor(page.meeting)).toBeNull();
    await expect(stat(join(root, "work", MEETING_ID))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(context.jobs.read(JobId(started.jobId)).chunks.at(-1)!.text)).toMatchObject({
      stage: "cleaning", percent: 100,
    });
  }, 180_000);
});
