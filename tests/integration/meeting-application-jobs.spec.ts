import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import { JobId } from "@deepseek-ai/dsh-jobs";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { afterEach, expect, it } from "vitest";

import { unusedAgentInbox } from "../helpers/unused-agent-inbox.js";

import {
  MEETING_ID,
  SECOND_MEETING_ID,
  TestAudioStore,
  createMeetingApplicationHarness,
  deferred,
  heldRunner,
  type MeetingApplicationHarness,
} from "../helpers/meeting-application-fixture.js";

const harnesses: MeetingApplicationHarness[] = [];

async function harness(options: Parameters<typeof createMeetingApplicationHarness>[0] = {}) {
  const value = await createMeetingApplicationHarness(options);
  harnesses.push(value);
  return value;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition did not become true");
}

function stubAgent(ctx: Context): { readonly agent: Agent; dispose(): Promise<void> } {
  const scopeFiber = ctx.plugin(() => {});
  const session = Session.create(SessionId("meeting-owner"));
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: unusedAgentInbox(),
    status: "idle",
    ctx: scopeFiber.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: "rejected" }) }),
    inject: () => {},
    cancel: () => {},
    runMaintenance: <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  };
  ctx.agents.register(agent);
  return { agent, dispose: async () => { await scopeFiber.dispose(); } };
}

afterEach(async () => {
  for (const value of harnesses.splice(0)) await value.dispose();
});

it("活动任务期间第二个导入同步返回 ENGINE_BUSY 且无副作用", async () => {
  const entered = deferred<void>();
  const value = await harness({ asr: heldRunner(entered) });
  const first = await value.application.startImport({ path: "/input/first.wav" });
  await entered.promise;

  await expect(value.application.startImport({ path: "/input/second.wav" }))
    .rejects.toMatchObject({ code: "ENGINE_BUSY" });
  expect(value.audio.opened).toEqual(["/input/first.wav"]);
  expect(value.repository.getMeeting(SECOND_MEETING_ID)).toBeNull();
  expect(value.context.jobs.list()).toHaveLength(1);

  expect(value.context.jobs.kill(JobId(first.jobId))).toBe("requested");
  await expect(value.context.jobs.wait(JobId(first.jobId), 2_000))
    .resolves.toMatchObject({ status: "killed" });
});

it("job_kill 先赢时立即建立取消栅栏并在 Worker/文件收敛后 killed", async () => {
  const entered = deferred<void>();
  const value = await harness({ asr: heldRunner(entered) });
  const started = await value.application.startImport({ path: "/private/meeting.wav" });
  await entered.promise;
  const progress = value.context.jobs.read(JobId(started.jobId)).chunks.at(-1)!.text;
  expect(Buffer.byteLength(progress)).toBeLessThan(4_096);
  expect(value.context.jobs.get(JobId(started.jobId)).outputLimitBytes).toBe(4_096);
  expect(Object.keys(JSON.parse(progress)).sort()).toEqual(["elapsed_ms", "percent", "stage"]);

  expect(value.context.jobs.kill(JobId(started.jobId), undefined, "user requested"))
    .toBe("requested");
  expect(value.repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "cancelled",
    transcriptVersion: 0,
    errorCode: "CANCELLED_BY_USER",
    errorStage: "transcribing",
  });
  const terminal = await value.context.jobs.wait(JobId(started.jobId), 2_000);
  expect(terminal).toMatchObject({ status: "killed", detail: "CANCELLED_BY_USER; user requested" });
  expect(value.audio.cleaned).toEqual([MEETING_ID]);
  expect(value.application.activeJobIdFor(value.repository.getMeeting(MEETING_ID)!)).toBeNull();
  const finalOutput = value.context.jobs.read(JobId(started.jobId)).chunks.at(-1)!.text;
  expect(JSON.parse(finalOutput)).toMatchObject({ error_code: "CANCELLED_BY_USER" });
  expect(finalOutput).not.toContain("private");
});

it("提交先赢后收到 job_kill 仍以 completed 结算", async () => {
  const cleanupGate = deferred<void>();
  const audio = new TestAudioStore({ cleanupGate: cleanupGate.promise });
  const value = await harness({ audio });
  const started = await value.application.startImport({ path: "/input.wav" });
  await waitUntil(() => audio.cleaned.length === 1);
  const committed = value.repository.getMeeting(MEETING_ID)!;
  expect(committed).toMatchObject({ status: "completed", transcriptVersion: 1 });
  expect(value.application.activeJobIdFor(committed)).toBeNull();
  expect(value.context.jobs.get(JobId(started.jobId)).status).toBe("running");
  await expect(value.application.startImport({ path: "/input/second.wav" }))
    .rejects.toMatchObject({ code: "ENGINE_BUSY" });
  expect(audio.opened).toEqual(["/input.wav"]);

  expect(value.context.jobs.kill(JobId(started.jobId))).toBe("requested");
  cleanupGate.resolve();
  await expect(value.context.jobs.wait(JobId(started.jobId), 2_000))
    .resolves.toMatchObject({ status: "completed" });
  expect(value.repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "completed", transcriptVersion: 1, errorCode: null,
  });
  expect(value.application.activeJobIdFor(value.repository.getMeeting(MEETING_ID)!)).toBeNull();
});

it("owner dispose 复用 DSH 清理语义取消并等待应用资源归零", async () => {
  const entered = deferred<void>();
  const value = await harness({ asr: heldRunner(entered) });
  const owner = stubAgent(value.context);
  const started = await value.application.startImport({
    path: "/input.wav",
    owner: owner.agent.session.id,
  });
  await entered.promise;

  await owner.dispose();
  expect(value.context.jobs.list(owner.agent.session.id)).toEqual([]);
  expect(value.repository.getMeeting(MEETING_ID)).toMatchObject({
    status: "cancelled", errorCode: "CANCELLED_BY_USER",
  });
  expect(value.audio.cleaned).toEqual([MEETING_ID]);
  expect(value.application.activeJobIdFor(value.repository.getMeeting(MEETING_ID)!)).toBeNull();
  expect(started.jobId).toBe("meeting-1");
});
