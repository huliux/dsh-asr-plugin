import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import LocalJobRegistry from "@deepseek-ai/dsh-jobs-local";
import { expect, it } from "vitest";

import { MeetingApplication } from "../../src/application/meeting-application.js";
import { openManagedAudioStore } from "../../src/storage/managed-audio-store.js";
import { openMeetingRepository } from "../../src/storage/meeting-repository.js";
import { MEETING_ID, RUN_ID, failingRunner } from "../helpers/meeting-application-fixture.js";
import { createWave } from "../helpers/wav-fixture.js";

it("启动与显式重转写都阻止异常录音时间轴固化，保留分块和 v0", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-recovery-bound-"));
  const context = new Context();
  const repository = openMeetingRepository(join(root, "meetings.sqlite3"));
  let application: MeetingApplication | undefined;
  try {
    await context.plugin(AgentRegistry);
    await context.plugin(LocalJobRegistry);
    const audioStore = await openManagedAudioStore({
      dataRoot: root,
      subprocess: { spawn() { throw new Error("Recovery must not start a subprocess"); } },
    });
    application = new MeetingApplication({
      dataRoot: root, audioStore, repository, jobs: context.jobs,
      engineFingerprint: "a".repeat(64), now: () => 3_000,
      asr: failingRunner(new Error("Recovery must not start ASR")),
      diarization: failingRunner(new Error("Recovery must not start diarization")),
    });
    repository.createRecording({ meetingId: MEETING_ID, runId: RUN_ID, title: "Clock drift", nowMs: 1_000 });
    repository.recordRecordingStarted({ meetingId: MEETING_ID, runId: RUN_ID, startedAtMs: 1_000 });
    repository.finishRun({
      meetingId: MEETING_ID, runId: RUN_ID, baseVersion: 0, outcome: "cancelled",
      errorCode: "CANCELLED_BY_USER", errorStage: "finalizing", nowMs: 2_000, recordingEndedAtMs: 2_000,
    });
    const layout = await audioStore.prepareRecording(MEETING_ID);
    const chunkPath = join(layout.recordingDirectory, "system", "chunks", "1000000-19000000.wav");
    const original = createWave(new Int16Array(18 * 16_000).fill(1_000));
    await writeFile(chunkPath, original);

    await expect(application.reconcileStartup()).resolves.toMatchObject({
      recoveredRecordingIds: [], failedRecordingRecoveryIds: [MEETING_ID],
    });
    await expect(application.startRetranscription({ meetingId: MEETING_ID, expectedVersion: 0 }))
      .rejects.toMatchObject({ code: "INVALID_MEETING_STATE" });
    expect(application.getMeetingPage({ meetingId: MEETING_ID })).toMatchObject({
      meeting: { transcriptVersion: 0, sourceSha256: null, errorCode: "AUDIO_RECOVERY_FAILED" },
      transcript: { available: false },
    });
    expect(context.jobs.list()).toEqual([]);
    expect(await readFile(chunkPath)).toEqual(original);
    await expect(stat(join(layout.meetingDirectory, "audio.wav"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (application === undefined) repository.close();
    else await application.shutdown();
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
