import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, opendir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Context, type Fiber } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent } from "@deepseek-ai/dsh-agent";
import LocalJobRegistry from "@deepseek-ai/dsh-jobs-local";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import * as ToolJobs from "@deepseek-ai/dsh-tool-jobs";
import ToolRuntime, { type ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import ApprovalService, { type ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import { afterEach, describe, expect, it } from "vitest";

import { unusedAgentInbox } from "../helpers/unused-agent-inbox.js";

import { MEETING_TOOL_NAMES } from "../../src/tools/meeting-tools.js";
import { prepareP1aRuntimeAssetFixture } from "../helpers/p1a-runtime-assets.js";

const suite = describe.skipIf(process.env.DSH_RUN_P1A_E2E !== "1");
const REPORT_PATH = resolve("data/p1a-e2e/latest.json");
const FORMAT_FIXTURES = [
  { sampleId: "four-zh-wav", format: "wav", path: resolve("data/p0-wav/four-zh.wav") },
  { sampleId: "four-zh-m4a", format: "m4a", path: resolve("data/p1a-input/four-zh.m4a") },
  { sampleId: "four-zh-mp3", format: "mp3", path: resolve("data/private-audio/4人中文.mp3") },
] as const;

interface MeetingValue {
  readonly meeting: {
    readonly source_format: "wav" | "m4a" | "mp3";
    readonly source_sha256: string | null;
    readonly duration_ms: number | null;
    readonly status: string;
    readonly transcript_version: number;
    readonly error_code: string | null;
  };
  readonly transcript: {
    readonly available: boolean;
    readonly segments: readonly {
      readonly anchor: string;
      readonly speaker_label: string;
      readonly text: string;
    }[];
    readonly next_cursor: string | null;
  };
}

interface StartedValue {
  readonly meeting_id: string;
  readonly job_id: string;
  readonly status: "processing";
}

interface JobOutputValue {
  readonly text: string;
  readonly job: { readonly id: string; readonly status: string };
}

interface SampleReport {
  sample_id: string;
  language: "zh-CN";
  expected_speakers: number;
  observed_speakers: number;
  source_format: string;
  source_sha256: string;
  status: string;
  error_code: string | null;
  duration_ms: number;
  transcript_version: number;
  segment_count: number;
  elapsed_ms: number;
  disk_delta_bytes: number;
  max_rss_bytes: number;
  retranscribe_elapsed_ms?: number;
}

interface E2eHost {
  readonly agent: Agent;
  readonly agentFiber: Fiber;
  readonly context: Context;
  readonly dataRoot: string;
  pluginFiber: Fiber | null;
}

let activeHost: E2eHost | undefined;
let callSequence = 0;

function probeAgent(context: Context): { agent: Agent; fiber: Fiber } {
  const fiber = context.plugin(() => undefined);
  const id = SessionId("p1a-e2e-agent");
  const session = Session.create(id);
  session.append("turn/start", { turn: 1 });
  const agent = {
    id,
    options: {},
    session,
    inbox: unusedAgentInbox(),
    status: "running",
    ctx: fiber.ctx,
    send: () => undefined,
    followup: () => undefined,
    inject: () => undefined,
    cancel: () => undefined,
    runMaintenance: <T>(job: (signal: AbortSignal) => Promise<T>) => (
      job(new AbortController().signal)
    ),
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent;
  context.agents.register(agent);
  return { agent, fiber };
}

async function createHost(): Promise<E2eHost> {
  const context = new Context();
  await context.plugin(AgentRegistry);
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime);
  await context.plugin(ApprovalService);
  await context.plugin(LocalJobRegistry);
  await context.plugin(LocalSubprocessRuntime);
  await context.plugin(ToolJobs, { completionDelivery: "quiet" });
  const { agent, fiber: agentFiber } = probeAgent(context);
  context.on("approval/request", () => Promise.resolve<ApprovalOutcome>("allowed-once"));
  const dataRoot = await mkdtemp(join(tmpdir(), "dsh-asr-p1a-e2e-"));
  await prepareP1aRuntimeAssetFixture({
    dataRoot,
    legacyAssetRoot: resolve("data/assets"),
    manifestPath: resolve("dist/assets/manifest.json"),
  });
  const specifier = new URL("../../dist/index.js", import.meta.url).href;
  const plugin = await import(specifier) as typeof import("../../src/index.js");
  const pluginFiber = await context.plugin(plugin, {
    data_dir: dataRoot,
  });
  return { agent, agentFiber, context, dataRoot, pluginFiber };
}

async function disposeHost(host: E2eHost): Promise<void> {
  await host.pluginFiber?.dispose();
  host.pluginFiber = null;
  await host.agentFiber.dispose();
  await host.context.fiber.dispose();
  await rm(host.dataRoot, { recursive: true, force: true });
}

function callTool(host: E2eHost, name: string, arguments_: Parameters<E2eHost["context"]["tools"]["execute"]>[0]["arguments"]) {
  callSequence += 1;
  return host.context.tools.execute({
    agent: host.agent,
    callId: ToolCallId(`p1a-e2e-${callSequence}`),
    name,
    arguments: arguments_,
    signal: new AbortController().signal,
  });
}

function successfulValue<T>(result: ToolExecutionResult): T {
  if (result.isError || result.value === undefined) {
    throw new Error(`P1a tool failed: ${result.error?.info?.code ?? "UNKNOWN"}`);
  }
  return result.value as T;
}

function resultCode(result: ToolExecutionResult): string | undefined {
  return result.error?.info?.code;
}

async function waitJob(host: E2eHost, jobId: string): Promise<JobOutputValue> {
  const result = await callTool(host, "job_output", {
    job_id: jobId,
    wait: true,
    timeout_ms: 600_000,
  });
  return successfulValue<JobOutputValue>(result);
}

async function sha256File(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function treeBytes(path: string): Promise<number> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;
  let total = 0;
  const directory = await opendir(path);
  for await (const entry of directory) total += await treeBytes(join(path, entry.name));
  return total;
}

async function getMeeting(
  host: E2eHost,
  meetingId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<MeetingValue> {
  const result = await callTool(host, "meeting_get", {
    meeting_id: meetingId,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  return successfulValue<MeetingValue>(result);
}

async function importFixture(
  host: E2eHost,
  fixture: typeof FORMAT_FIXTURES[number],
): Promise<{ meetingId: string; page: MeetingValue; report: SampleReport }> {
  const beforeBytes = await treeBytes(host.dataRoot);
  const startedAt = performance.now();
  const started = successfulValue<StartedValue>(await callTool(
    host,
    "meeting_import_transcribe",
    { path: fixture.path, title: fixture.sampleId },
  ));
  const output = await waitJob(host, started.job_id);
  expect(output.job.status, output.text).toBe("completed");
  const elapsedMs = Math.round(performance.now() - startedAt);
  const page = await getMeeting(host, started.meeting_id);
  const hash = await sha256File(fixture.path);
  expect(page.meeting.source_format).toBe(fixture.format);
  expect(page.meeting.source_sha256).toBe(hash);
  expect(page.transcript.available).toBe(true);
  expect(page.transcript.segments.length).toBeGreaterThan(0);
  const speakers = new Set(page.transcript.segments
    .map((segment) => segment.speaker_label)
    .filter((speaker) => speaker !== "UNKNOWN"));
  return {
    meetingId: started.meeting_id,
    page,
    report: {
      sample_id: fixture.sampleId,
      language: "zh-CN",
      expected_speakers: 4,
      observed_speakers: speakers.size,
      source_format: fixture.format,
      source_sha256: hash,
      status: page.meeting.status,
      error_code: page.meeting.error_code,
      duration_ms: page.meeting.duration_ms!,
      transcript_version: page.meeting.transcript_version,
      segment_count: page.transcript.segments.length,
      elapsed_ms: elapsedMs,
      disk_delta_bytes: Math.max(0, await treeBytes(host.dataRoot) - beforeBytes),
      max_rss_bytes: process.resourceUsage().maxRSS * 1_024,
    },
  };
}

async function exerciseBusyAndKill(host: E2eHost): Promise<void> {
  const started = successfulValue<StartedValue>(await callTool(host, "meeting_import_transcribe", {
    path: resolve("data/private-audio/ex01.m4a"),
    title: "p1a-busy-probe",
  }));
  const busy = await callTool(host, "meeting_import_transcribe", {
    path: FORMAT_FIXTURES[0].path,
    title: "must-not-start",
  });
  expect(resultCode(busy)).toBe("ENGINE_BUSY");
  const output = successfulValue<JobOutputValue>(await callTool(host, "job_output", {
    job_id: started.job_id,
  }));
  expect(output.job.id).toBe(started.job_id);
  const killed = successfulValue<{ outcome: string }>(await callTool(host, "job_kill", {
    job_id: started.job_id,
    reason: "P1a cancellation probe",
  }));
  expect(killed.outcome).toBe("cancellation-requested");
  expect((await waitJob(host, started.job_id)).job.status).toBe("killed");
  const page = await getMeeting(host, started.meeting_id);
  expect(page.meeting).toMatchObject({ status: "cancelled", transcript_version: 0 });
  await deleteMeeting(host, started.meeting_id, 0);
}

function searchSeed(page: MeetingValue): string {
  const text = page.transcript.segments[0]?.text.trim() ?? "";
  const seed = Array.from(text).slice(0, 2).join("");
  if (seed.length === 0) throw new Error("P1a transcript did not yield a search seed");
  return seed;
}

async function exercisePaginationAndSearch(
  host: E2eHost,
  meetingId: string,
  fullPage: MeetingValue,
): Promise<void> {
  const first = await getMeeting(host, meetingId, { limit: 1 });
  expect(first.transcript.segments).toHaveLength(1);
  expect(first.transcript.next_cursor).not.toBeNull();
  const second = await getMeeting(host, meetingId, {
    cursor: first.transcript.next_cursor!,
    limit: 1,
  });
  expect(second.transcript.segments[0]?.anchor).not.toBe(first.transcript.segments[0]?.anchor);
  const searched = successfulValue<{ items: { meeting_id: string }[] }>(await callTool(
    host,
    "meeting_search",
    { query: searchSeed(fullPage), limit: 10 },
  ));
  expect(searched.items.some((item) => item.meeting_id === meetingId)).toBe(true);
}

async function exerciseRetranscription(
  host: E2eHost,
  meetingId: string,
): Promise<{ elapsedMs: number; page: MeetingValue }> {
  const startedAt = performance.now();
  const started = successfulValue<StartedValue & { target_version: number }>(await callTool(
    host,
    "meeting_retranscribe",
    { meeting_id: meetingId, expected_transcript_version: 1 },
  ));
  expect(started.target_version).toBe(2);
  expect((await waitJob(host, started.job_id)).job.status).toBe("completed");
  const page = await getMeeting(host, meetingId);
  expect(page.meeting.transcript_version).toBe(2);
  return { elapsedMs: Math.round(performance.now() - startedAt), page };
}

async function deleteMeeting(host: E2eHost, meetingId: string, version: number): Promise<void> {
  const deleted = successfulValue<{ deleted: boolean }>(await callTool(host, "meeting_delete", {
    meeting_id: meetingId,
    expected_transcript_version: version,
  }));
  expect(deleted.deleted).toBe(true);
}

async function exerciseUnload(host: E2eHost): Promise<void> {
  const started = successfulValue<StartedValue>(await callTool(host, "meeting_import_transcribe", {
    path: resolve("data/private-audio/ex01.m4a"),
    title: "p1a-unload-probe",
  }));
  await host.pluginFiber!.dispose();
  host.pluginFiber = null;
  expect((await waitJob(host, started.job_id)).job.status).toBe("killed");
  const names = host.context.tools.schemas().map((schema) => schema.name);
  for (const toolName of MEETING_TOOL_NAMES) expect(names).not.toContain(toolName);
}

async function writeReport(samples: readonly SampleReport[]): Promise<void> {
  await mkdir(resolve("data/p1a-e2e"), { recursive: true, mode: 0o700 });
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    samples,
    checks: {
      engine_busy: "ENGINE_BUSY",
      job_kill: "killed",
      retranscript_version: 2,
      plugin_unload: "killed",
    },
  };
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(REPORT_PATH, 0o600);
}

afterEach(async () => {
  if (activeHost !== undefined) await disposeHost(activeHost);
  activeHost = undefined;
});

suite("P1a 真实 DSH 五工具闭环", () => {
  it("覆盖三格式、job 控制、分页检索、重跑删除与卸载", async () => {
    const host = await createHost();
    activeHost = host;
    await exerciseBusyAndKill(host);
    const imported = [];
    for (const fixture of FORMAT_FIXTURES) imported.push(await importFixture(host, fixture));
    await exercisePaginationAndSearch(host, imported[0]!.meetingId, imported[0]!.page);
    const retranscribed = await exerciseRetranscription(host, imported[0]!.meetingId);
    imported[0]!.report.transcript_version = retranscribed.page.meeting.transcript_version;
    imported[0]!.report.retranscribe_elapsed_ms = retranscribed.elapsedMs;
    for (const item of imported.slice(1)) await deleteMeeting(host, item.meetingId, 1);
    await deleteMeeting(host, imported[0]!.meetingId, 2);
    const missing = await callTool(host, "meeting_get", { meeting_id: imported[0]!.meetingId });
    expect(resultCode(missing)).toBe("MEETING_NOT_FOUND");
    await exerciseUnload(host);
    await writeReport(imported.map((item) => item.report));
  }, 600_000);
});
