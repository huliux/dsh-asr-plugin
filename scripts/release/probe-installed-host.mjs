import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { useInstalledHostModules } from "./installed-host-modules.mjs";

const hostEntry = process.env.P1B_DSH_HOST_ENTRY;
if (!hostEntry) throw new Error("missing P1B_DSH_HOST_ENTRY");
const hostRequire = createRequire(hostEntry);
const loadHost = name => import(pathToFileURL(hostRequire.resolve(`@deepseek-ai/${name}`)).href);
useInstalledHostModules(hostEntry);
const { Context } = await loadHost("cordis");
const { default: AgentRegistry } = await loadHost("dsh-agent");
const { default: LocalJobRegistry } = await loadHost("dsh-jobs-local");
const { Session, SessionId } = await loadHost("dsh-session");
const { default: LocalSpillStore } = await loadHost("dsh-spill-local");
const SpillPolicy = await loadHost("dsh-spill-policy");
const { default: SystemPrompt } = await loadHost("dsh-system-prompt");
const { default: LocalSubprocessRuntime } = await loadHost("dsh-subprocess-local");
const ToolJobs = await loadHost("dsh-tool-jobs");
const { default: ToolRuntime } = await loadHost("dsh-tools");
const { default: ApprovalService } = await loadHost("dsh-user-approval");
const plugin = await import("@huliux/dsh-asr-plugin");

let callSequence = 0;
let currentPhase = "BOOT";
const LONG_MEETING_ID = "55555555-5555-4555-8555-555555555555";
const LONG_RUN_ID = "66666666-6666-4666-8666-666666666666";
const LONG_SEGMENT_COUNT = 1_200;

function enterPhase(phase) {
  currentPhase = phase;
}

function invariant(condition, code) {
  if (condition) return;
  const error = new Error(code);
  error.code = code;
  throw error;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

function installedPackageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.resolve("@huliux/dsh-asr-plugin"))));
}

function longTranscriptSegments() {
  return Array.from({ length: LONG_SEGMENT_COUNT }, (_, seq) => ({
    seq,
    startMs: seq * 1_000,
    endMs: seq * 1_000 + 750,
    speakerLabel: seq % 2 === 0 ? "Speaker A" : "Speaker B",
    text: `Installed Agent projection segment ${seq}`.padEnd(160, "."),
  }));
}

async function seedLongMeeting(dataRoot) {
  const databaseRoot = join(dataRoot, "db");
  await mkdir(databaseRoot, { recursive: true, mode: 0o700 });
  const repositoryModule = await import(pathToFileURL(join(
    installedPackageRoot(),
    "dist/storage/meeting-repository.js",
  )).href);
  const repository = repositoryModule.openMeetingRepository(join(databaseRoot, "meetings.sqlite3"));
  try {
    repository.createImport({
      meetingId: LONG_MEETING_ID,
      title: "Installed long transcript",
      sourceName: "installed-long.wav",
      sourceFormat: "wav",
      sourceSizeBytes: 1_024,
      runId: LONG_RUN_ID,
      nowMs: 1_000,
    });
    repository.commitTranscript({
      meetingId: LONG_MEETING_ID,
      runId: LONG_RUN_ID,
      baseVersion: 0,
      resultStatus: "completed",
      resultReason: null,
      durationMs: LONG_SEGMENT_COUNT * 1_000,
      engineFingerprint: "a".repeat(64),
      segments: longTranscriptSegments(),
      nowMs: 1_001,
    });
  } finally {
    repository.close();
  }
}

function assertInstalledResolution() {
  const resolved = realpathSync(fileURLToPath(import.meta.resolve("@huliux/dsh-asr-plugin")));
  const profileRoot = realpathSync(requiredEnvironment("P1B_PROFILE_ROOT"));
  assert.ok(resolved.startsWith(`${profileRoot}/`));
  const forbidden = JSON.parse(requiredEnvironment("P1B_FORBIDDEN_PATHS"));
  assert.ok(Array.isArray(forbidden));
  for (const path of forbidden) assert.equal(resolved.includes(path), false);
}

function unusedInbox() {
  const unexpected = () => { throw new Error("This probe does not drive Agent input"); };
  return { nextTurn: [], nextStep: [], clear: unexpected, append: unexpected,
    prepend: unexpected, replace: unexpected, remove: unexpected, splice: unexpected };
}

function probeAgent(context) {
  const fiber = context.plugin(() => undefined);
  const id = SessionId("p1b-installed-artifact-probe");
  const session = Session.create(id);
  session.append("turn/start", { turn: 1 });
  const agent = {
    id,
    options: {},
    session,
    inbox: unusedInbox(),
    status: "running",
    ctx: fiber.ctx,
    send() {},
    followup() {},
    inject() {},
    cancel() {},
    runMaintenance: (job) => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  };
  context.agents.register(agent);
  return { agent, fiber };
}

async function createHost(dataRoot) {
  const context = new Context();
  await context.plugin(AgentRegistry);
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime);
  await context.plugin(LocalSpillStore, { root: join(dataRoot, "probe-spill"), cleanupPeriodDays: 0 });
  await context.plugin(SpillPolicy, { maxInlineBytes: 50_000 });
  await context.plugin(ApprovalService);
  await context.plugin(LocalJobRegistry);
  await context.plugin(LocalSubprocessRuntime);
  await context.plugin(ToolJobs, { completionDelivery: "quiet" });
  context.on("approval/request", () => Promise.resolve("allowed-once"));
  const { agent, fiber: agentFiber } = probeAgent(context);
  const pluginFiber = await context.plugin(plugin, { data_dir: dataRoot });
  return { agent, agentFiber, context, pluginFiber };
}

async function disposeHost(host) {
  await host.pluginFiber?.dispose();
  await host.agentFiber.dispose();
  await host.context.fiber.dispose();
}

function callTool(host, name, arguments_) {
  callSequence += 1;
  return host.context.tools.execute({
    agent: host.agent,
    callId: `p1b-installed-${callSequence}`,
    name,
    arguments: arguments_,
    signal: new AbortController().signal,
  });
}

function value(result) {
  if (result.isError || result.value === undefined) {
    const code = result.error?.info?.code ?? "UNKNOWN";
    const error = new Error(`tool failed: ${code}`);
    error.code = code;
    throw error;
  }
  return result.value;
}

async function waitJob(host, jobId) {
  return value(await callTool(host, "job_output", {
    job_id: jobId,
    wait: true,
    timeout_ms: 900_000,
  }));
}

async function meetingGet(host, meetingId) {
  return value(await callTool(host, "meeting_get", {
    meeting_id: meetingId,
    limit: 50,
  }));
}

async function importMeeting(host, path, format) {
  const started = value(await callTool(host, "meeting_import_transcribe", {
    path,
    title: `p1b-${format}`,
  }));
  const output = await waitJob(host, started.job_id);
  invariant(output.job.status === "completed", `IMPORT_${format.toUpperCase()}_JOB_FAILED`);
  const page = await meetingGet(host, started.meeting_id);
  invariant(page.meeting.source_format === format, `IMPORT_${format.toUpperCase()}_FORMAT_FAILED`);
  invariant(["completed", "partial"].includes(page.meeting.status),
    `IMPORT_${format.toUpperCase()}_STATUS_FAILED`);
  invariant(page.transcript.available === true, `IMPORT_${format.toUpperCase()}_TRANSCRIPT_MISSING`);
  invariant(page.transcript.segments.length > 0, `IMPORT_${format.toUpperCase()}_SEGMENTS_EMPTY`);
  return { meetingId: started.meeting_id, page };
}

async function exerciseCancellation(host, path) {
  const started = value(await callTool(host, "meeting_import_transcribe", {
    path,
    title: "p1b-cancellation",
  }));
  const killed = value(await callTool(host, "job_kill", {
    job_id: started.job_id,
    reason: "P1b installed-artifact cancellation probe",
  }));
  assert.equal(killed.outcome, "cancellation-requested");
  assert.equal((await waitJob(host, started.job_id)).job.status, "killed");
  const page = await meetingGet(host, started.meeting_id);
  assert.equal(page.meeting.status, "cancelled");
  const deleted = value(await callTool(host, "meeting_delete", {
    meeting_id: started.meeting_id,
    expected_transcript_version: 0,
  }));
  assert.equal(deleted.deleted, true);
}

function searchSeed(page) {
  const text = page.transcript.segments[0]?.text?.trim() ?? "";
  const seed = Array.from(text).slice(0, 2).join("");
  if (seed.length === 0) throw new Error("empty search seed");
  return seed;
}

async function searchAndRetranscribe(host, imported) {
  const searched = value(await callTool(host, "meeting_search", {
    query: searchSeed(imported.page),
    limit: 10,
  }));
  assert.ok(searched.items.some((item) => item.meeting_id === imported.meetingId));
  const started = value(await callTool(host, "meeting_retranscribe", {
    meeting_id: imported.meetingId,
    expected_transcript_version: 1,
  }));
  assert.equal(started.target_version, 2);
  assert.equal((await waitJob(host, started.job_id)).job.status, "completed");
  const page = await meetingGet(host, imported.meetingId);
  assert.equal(page.meeting.transcript_version, 2);
  invariant(["completed", "partial"].includes(page.meeting.status),
    "RETRANSCRIBE_STATUS_FAILED");
  return page;
}

async function readAgentProjection(host, meetingId) {
  const seen = [];
  let cursor;
  let pageCount = 0;
  do {
    const result = await callTool(host, "meeting_get", {
      meeting_id: meetingId,
      projection: "agent",
      ...(cursor === undefined ? {} : { cursor }),
    });
    const text = result.content.map((block) => block.type === "text" ? block.text : "").join("");
    invariant(!text.includes("Full formatted result stored at:"), "AGENT_PROJECTION_SPILLED");
    const page = JSON.parse(text.split("<meeting_data>\n")[1]?.split("\n</meeting_data>")[0] ?? "null");
    invariant(JSON.stringify(page) === JSON.stringify(value(result)), "AGENT_PROJECTION_CONTENT_CHANGED");
    pageCount += 1;
    invariant(page.transcript.available === true, "AGENT_PROJECTION_UNAVAILABLE");
    invariant(page.transcript.version === 1, "AGENT_PROJECTION_VERSION_CHANGED");
    for (const segment of page.transcript.segments) {
      invariant(segment.seq === seen.length, "AGENT_PROJECTION_SEQUENCE_GAP");
      seen.push(segment.seq);
    }
    cursor = page.transcript.next_cursor ?? undefined;
    invariant(page.transcript.coverage.complete === (cursor === undefined),
      "AGENT_PROJECTION_COVERAGE_INVALID");
    invariant(pageCount <= 100, "AGENT_PROJECTION_CURSOR_LOOP");
  } while (cursor !== undefined);
  invariant(seen.length === LONG_SEGMENT_COUNT, "AGENT_PROJECTION_INCOMPLETE");
  invariant(pageCount > 1, "AGENT_PROJECTION_NOT_PAGINATED");
  return seen.length;
}

function verifyExportReceipt(receipt, meetingId, format, bytes, overwritten) {
  assert.equal(receipt.meeting_id, meetingId);
  assert.equal(receipt.format, format);
  assert.equal(receipt.bytes, bytes.byteLength);
  assert.equal(receipt.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(receipt.overwritten, overwritten);
}

async function exerciseTranscriptExport(host, meetingId) {
  const outputRoot = await mkdtemp(join(tmpdir(), "dsh-asr-installed-export-"));
  try {
    const markdownPath = join(outputRoot, "transcript.md");
    const markdown = value(await callTool(host, "meeting_transcript_export", {
      meeting_id: meetingId,
      format: "md",
      output_path: markdownPath,
    }));
    const markdownBytes = await readFile(markdownPath);
    verifyExportReceipt(markdown, meetingId, "md", markdownBytes, false);
    invariant(markdownBytes.includes(meetingId), "EXPORT_MARKDOWN_METADATA_MISSING");

    const protectedResult = await callTool(host, "meeting_transcript_export", {
      meeting_id: meetingId,
      format: "md",
      output_path: markdownPath,
    });
    invariant(protectedResult.isError &&
      protectedResult.error?.info?.code === "EXPORT_TARGET_EXISTS",
    "EXPORT_TARGET_PROTECTION_FAILED");
    const replaced = value(await callTool(host, "meeting_transcript_export", {
      meeting_id: meetingId,
      format: "md",
      output_path: markdownPath,
      overwrite: true,
    }));
    verifyExportReceipt(replaced, meetingId, "md", await readFile(markdownPath), true);

    const subtitlePath = join(outputRoot, "transcript.srt");
    const subtitle = value(await callTool(host, "meeting_transcript_export", {
      meeting_id: meetingId,
      format: "srt",
      output_path: subtitlePath,
      include_speakers: false,
    }));
    const subtitleBytes = await readFile(subtitlePath);
    verifyExportReceipt(subtitle, meetingId, "srt", subtitleBytes, false);
    invariant(/^1\n\d{2}:\d{2}:\d{2},\d{3} --> /.test(subtitleBytes.toString("utf8")),
      "EXPORT_SRT_INVALID");
    invariant((await readdir(outputRoot)).every((name) => !name.startsWith(".dsh-asr-export-")),
      "EXPORT_TEMP_FILE_REMAINED");
    return { formats: ["md", "srt"], targetProtected: true };
  } finally {
    await rm(outputRoot, { force: true, recursive: true });
  }
}

async function deleteMeeting(host, meetingId) {
  const page = await meetingGet(host, meetingId);
  const deleted = value(await callTool(host, "meeting_delete", {
    meeting_id: meetingId,
    expected_transcript_version: page.meeting.transcript_version,
  }));
  assert.equal(deleted.deleted, true);
}

async function controlRecording(host, action, meetingId) {
  return value(await callTool(host, "meeting_recording_control", {
    action,
    ...(meetingId === undefined ? { title: "p1c-installed-recording" } : { meeting_id: meetingId }),
  }));
}

async function waitForDraft(host, meetingId) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const page = value(await callTool(host, "meeting_live_get", {
      meeting_id: meetingId,
      limit: 1,
    }));
    if (page.provisional && page.revision >= 1 && page.audio_through_ms >= 5_000) return page;
    await delay(250);
  }
  invariant(false, "RECORDING_DRAFT_NOT_VISIBLE");
}

function assertDualRecording(view) {
  invariant(view.phase === "recording", "RECORDING_PHASE_INVALID");
  invariant(view.mic.state === "on", "RECORDING_MIC_NOT_ON");
  invariant(view.system.state === "on", "RECORDING_SYSTEM_NOT_ON");
}

async function waitForDualRecording(host, initial) {
  const deadline = Date.now() + 30_000;
  let view = initial;
  while (view.mic.state !== "on" || view.system.state !== "on") {
    if (view.mic.state === "failed") invariant(false, "RECORDING_MIC_NOT_ON");
    if (view.system.state === "failed") invariant(false, "RECORDING_SYSTEM_NOT_ON");
    if (Date.now() >= deadline) assertDualRecording(view);
    invariant(view.mic.state === "on" || view.system.state === "on",
      "RECORDING_NO_READY_TRACK");
    const pollAction = view.mic.state === "on" ? "mic_on" : "system_on";
    await delay(250);
    view = await controlRecording(host, pollAction, view.meeting_id);
  }
  assertDualRecording(view);
  return view;
}

async function recordMeeting(host, toggleTracks) {
  const started = await controlRecording(host, "start");
  await waitForDualRecording(host, started);
  if (toggleTracks) {
    await delay(6_000);
    invariant((await controlRecording(host, "mic_off", started.meeting_id)).mic.state === "off",
      "RECORDING_MIC_OFF_FAILED");
    const micStarted = await controlRecording(host, "mic_on", started.meeting_id);
    await waitForDualRecording(host, micStarted);
    invariant((await controlRecording(host, "system_off", started.meeting_id)).system.state === "off",
      "RECORDING_SYSTEM_OFF_FAILED");
    const systemStarted = await controlRecording(host, "system_on", started.meeting_id);
    await waitForDualRecording(host, systemStarted);
  }
  const live = await waitForDraft(host, started.meeting_id);
  const stopped = await controlRecording(host, "stop", started.meeting_id);
  invariant(["completed", "partial", "empty"].includes(stopped.phase),
    "RECORDING_STOP_STATUS_FAILED");
  invariant(stopped.transcript_version === 1 && stopped.finalization_ms < 30_000,
    "RECORDING_STOP_DEADLINE_FAILED");
  const committed = await meetingGet(host, started.meeting_id);
  invariant(committed.transcript.available && committed.transcript.version === 1,
    "RECORDING_COMMITTED_RESULT_MISSING");
  return {
    meetingId: started.meeting_id,
    draftRevision: live.revision,
    finalizationMs: stopped.finalization_ms,
    resultStatus: stopped.result_status,
  };
}

async function exerciseRecording() {
  const dataRoot = requiredEnvironment("P1B_DATA_ROOT");
  let host = await createHost(dataRoot);
  let first;
  try {
    enterPhase("RECORDING_FIRST_USE");
    first = await recordMeeting(host, true);
  } finally {
    await disposeHost(host);
  }
  host = await createHost(dataRoot);
  try {
    enterPhase("RECORDING_RESTART");
    const persisted = await meetingGet(host, first.meetingId);
    invariant(persisted.meeting.transcript_version === 1, "RECORDING_RESTART_DATA_MISSING");
    const second = await recordMeeting(host, false);
    await deleteMeeting(host, first.meetingId);
    await deleteMeeting(host, second.meetingId);
    return {
      status: "passed",
      first_use_tracks: ["mic", "system"],
      restart_tracks: ["mic", "system"],
      draft_revision_observed: Math.min(first.draftRevision, second.draftRevision),
      max_finalization_ms: Math.max(first.finalizationMs, second.finalizationMs),
      result_statuses: [first.resultStatus, second.resultStatus],
      max_rss_bytes: process.resourceUsage().maxRSS * 1024,
    };
  } finally {
    await disposeHost(host);
  }
}

function verifyClientExport() {
  enterPhase("CLIENT_EXPORT");
  const resolved = realpathSync(fileURLToPath(import.meta.resolve("@huliux/dsh-asr-plugin/client")));
  const profileRoot = realpathSync(requiredEnvironment("P1B_PROFILE_ROOT"));
  invariant(resolved.startsWith(`${profileRoot}/`), "CLIENT_EXPORT_SOURCE_LEAK");
  invariant(statSync(resolved).isFile() && statSync(resolved).size > 0, "CLIENT_EXPORT_MISSING");
  return { status: "passed", export: "./client" };
}

async function exercise() {
  const dataRoot = requiredEnvironment("P1B_DATA_ROOT");
  await seedLongMeeting(dataRoot);
  let host = await createHost(dataRoot);
  let retained;
  let agentProjectionSegments;
  let transcriptExport;
  try {
    enterPhase("CANCELLATION");
    await exerciseCancellation(host, requiredEnvironment("P1B_AUDIO_WAV"));
    const imported = [];
    enterPhase("IMPORT_WAV");
    imported.push(await importMeeting(host, requiredEnvironment("P1B_AUDIO_WAV"), "wav"));
    enterPhase("IMPORT_M4A");
    imported.push(await importMeeting(host, requiredEnvironment("P1B_AUDIO_M4A"), "m4a"));
    enterPhase("IMPORT_MP3");
    imported.push(await importMeeting(host, requiredEnvironment("P1B_AUDIO_MP3"), "mp3"));
    enterPhase("SEARCH_RETRANSCRIBE");
    const retranscribed = await searchAndRetranscribe(host, imported[0]);
    enterPhase("AGENT_PROJECTION");
    agentProjectionSegments = await readAgentProjection(host, LONG_MEETING_ID);
    enterPhase("TRANSCRIPT_EXPORT");
    transcriptExport = await exerciseTranscriptExport(host, imported[0].meetingId);
    enterPhase("DELETE");
    await deleteMeeting(host, LONG_MEETING_ID);
    await deleteMeeting(host, imported[1].meetingId);
    await deleteMeeting(host, imported[2].meetingId);
    retained = {
      meetingId: imported[0].meetingId,
      status: retranscribed.meeting.status,
    };
  } finally {
    await disposeHost(host);
  }
  enterPhase("RESTART");
  host = await createHost(dataRoot);
  try {
    const page = await meetingGet(host, retained.meetingId);
    invariant(page.meeting.status === retained.status, "RESTART_STATUS_CHANGED");
    invariant(page.meeting.transcript_version === 2, "RESTART_VERSION_CHANGED");
  } finally {
    await disposeHost(host);
  }
  return {
    status: "passed",
    retained_meeting_id: retained.meetingId,
    retained_status: retained.status,
    imported_formats: ["wav", "m4a", "mp3"],
    transcript_version: 2,
    agent_projection_segments: agentProjectionSegments,
    export_formats: transcriptExport.formats,
    export_target_protected: transcriptExport.targetProtected,
    max_rss_bytes: process.resourceUsage().maxRSS * 1024,
  };
}

async function verifyPersistence() {
  enterPhase("PERSISTENCE");
  const host = await createHost(requiredEnvironment("P1B_DATA_ROOT"));
  try {
    const page = await meetingGet(host, requiredEnvironment("P1B_MEETING_ID"));
    invariant(page.meeting.status === requiredEnvironment("P1B_MEETING_STATUS"),
      "PERSISTENCE_STATUS_CHANGED");
    invariant(page.meeting.transcript_version === 2, "PERSISTENCE_VERSION_CHANGED");
    return { status: "passed", result_status: page.meeting.status, transcript_version: 2 };
  } finally {
    await disposeHost(host);
  }
}

async function leaseOwner() {
  enterPhase("LEASE_OWNER");
  const host = await createHost(requiredEnvironment("P1B_DATA_ROOT"));
  try {
    const started = value(await callTool(host, "meeting_import_transcribe", {
      path: requiredEnvironment("P1B_AUDIO_MP3"),
      title: "p1b-lease-overlap",
    }));
    await delay(250);
    const active = value(await callTool(host, "job_output", { job_id: started.job_id }));
    invariant(active.job.status === "running", "LEASE_OWNER_NOT_PROCESSING");
    process.stdout.write(`${JSON.stringify({ event: "processing" })}\n`);
    const output = await waitJob(host, started.job_id);
    invariant(output.job.status === "completed", "LEASE_OWNER_COMMIT_FAILED");
    const page = await meetingGet(host, started.meeting_id);
    invariant(["completed", "partial"].includes(page.meeting.status), "LEASE_OWNER_RESULT_FAILED");
    invariant(page.transcript.available === true, "LEASE_OWNER_TRANSCRIPT_MISSING");
    await deleteMeeting(host, started.meeting_id);
    return { status: "passed", event: "committed" };
  } finally {
    await disposeHost(host);
  }
}

try {
  assertInstalledResolution();
  const command = process.argv[2];
  const result = command === "exercise"
    ? await exercise()
    : command === "verify-persistence"
      ? await verifyPersistence()
      : command === "lease-owner"
        ? await leaseOwner()
        : command === "recording"
          ? await exerciseRecording()
          : command === "client-export"
            ? verifyClientExport()
      : undefined;
  if (result === undefined) throw new Error("unknown command");
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" &&
    error.code !== "ERR_ASSERTION" ? error.code : `INSTALLED_HOST_${currentPhase}_FAILED`;
  process.stdout.write(`${JSON.stringify({ status: "failed", error_code: code })}\n`);
  process.exitCode = 1;
}
