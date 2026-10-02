import { useInstalledHostModules } from "./installed-host-modules.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const [mode, dataRoot, audioPath, workspace, hostEntry] = process.argv.slice(2);
const hostRequire = createRequire(hostEntry);
const loadHost = (name) => import(pathToFileURL(hostRequire.resolve(`@deepseek-ai/${name}`)).href);
useInstalledHostModules(hostEntry);
const { Context } = await loadHost("cordis");
const { Session, SessionId } = await loadHost("dsh-session");
const ToolJobs = await loadHost("dsh-tool-jobs");
const plugin = await import("@huliux/dsh-asr-plugin");
assert(["base", "enhanced"].includes(mode));
let sequence = 0;
let rpc;
const context = new Context();
let agentFiber;
let pluginFiber;
let playback;
let phase = "setup";

function call(name, args) {
  return context.tools.execute({ agent, callId: `model-mode-${++sequence}`, name,
    arguments: args, signal: new AbortController().signal });
}

async function value(name, args) {
  const result = await call(name, args);
  if (result.isError) throw Object.assign(new Error("Installed tool failed"),
    { code: result.error?.info?.code ?? "TOOL_FAILED" });
  return result.value;
}

const session = Session.create(SessionId("model-mode-probe"));
session.append("turn/start", { turn: 1 });
const agent = {
  id: session.id, options: {}, session, inbox: {}, status: "running",
  send() {}, followup() {}, inject() {}, cancel() {},
  runMaintenance: (job) => job(new AbortController().signal), whenIdle: () => Promise.resolve(),
};

async function postMeeting(meetingId) {
  phase = "meeting_read";
  const page = await value("meeting_get", { meeting_id: meetingId });
  assert.equal(page.meeting.transcript_identity.mode, mode);
  assert(page.transcript.available && page.transcript.segments.length > 0);
  phase = "agent_projection";
  const projection = await value("meeting_get", { meeting_id: meetingId, projection: "agent" });
  assert(projection.transcript.available);
  phase = "meeting_search";
  const search = await value("meeting_search", { query: Array.from(page.transcript.segments[0].text).slice(0, 2).join("") });
  assert(search.items.some((item) => item.meeting_id === meetingId));
  phase = "meeting_reference";
  const reference = await rpc("references/resolve", { locale: "zh-CN", meeting_id: meetingId },
    new AbortController().signal);
  assert(reference.ok);
  for (const format of ["md", "txt", "srt", "vtt"]) {
    phase = `export_${format}`;
    const outputPath = join(workspace, `${meetingId}.${format}`);
    const receipt = await value("meeting_transcript_export", { meeting_id: meetingId,
      output_path: outputPath, format });
    assert(receipt.bytes > 0);
    assert((await readFile(outputPath, "utf8")).includes(page.transcript.segments[0].text));
  }
  return { segments: page.transcript.segments.length,
    speakers: new Set(page.transcript.segments.map((segment) => segment.speaker_label)).size,
    identity: page.meeting.transcript_identity, search: true, reference: true,
    exports: ["md", "txt", "srt", "vtt"], agentProjection: true };
}

async function importMeeting() {
  const startedAt = performance.now();
  const started = await value("meeting_import_transcribe", { path: audioPath, title: `Mode ${mode} import` });
  await pluginFiber.update({ data_dir: dataRoot, punctuation_enabled: mode !== "enhanced" });
  const job = await value("job_output", { job_id: started.job_id, wait: true, timeout_ms: 600_000 });
  phase = "import_job_completion";
  if (job.job.status !== "completed") {
    const page = await value("meeting_get", { meeting_id: started.meeting_id });
    throw Object.assign(new Error("Import failed"), { code: page.meeting.error_code ?? "IMPORT_JOB_FAILED" });
  }
  await pluginFiber.update({ data_dir: dataRoot, punctuation_enabled: mode === "enhanced" });
  return { ...await postMeeting(started.meeting_id), elapsedMs: Math.round(performance.now() - startedAt),
    selectionChangeDidNotRestart: true };
}

async function recordMeeting() {
  const started = await value("meeting_recording_control", { action: "start", title: `Mode ${mode} recording` });
  await value("meeting_recording_control", { action: "mic_off", meeting_id: started.meeting_id });
  phase = "system_track_ready";
  const trackDeadline = Date.now() + 45_000;
  let trackState;
  while (Date.now() < trackDeadline) {
    const state = await rpc("state", {}, new AbortController().signal);
    trackState = state.value?.recording?.system;
    if (trackState?.state === "on" || trackState?.state === "failed") break;
    await delay(250);
  }
  if (trackState?.state !== "on") throw Object.assign(new Error("System track not ready"),
    { code: trackState?.error_code ?? "SYSTEM_TRACK_NOT_READY" });
  phase = "recording_draft";
  await pluginFiber.update({ data_dir: dataRoot, punctuation_enabled: mode !== "enhanced" });
  const playbackStarted = performance.now();
  playback = spawn("/usr/bin/afplay", [audioPath], { stdio: "ignore" });
  playback.on("error", () => undefined);
  const deadline = Date.now() + 45_000;
  let live;
  while (Date.now() < deadline) {
    live = await value("meeting_live_get", { meeting_id: started.meeting_id, limit: 10 });
    if (live.segments.length > 0 && live.audio_through_ms >= 5_000) break;
    await delay(250);
  }
  assert(live?.segments.length > 0, "Nonempty recording draft is required");
  assert.equal(live.stale, false, "Draft freshness must meet the existing gate");
  const draftElapsedMs = Math.round(performance.now() - playbackStarted);
  const stopped = await value("meeting_recording_control", { action: "stop", meeting_id: started.meeting_id });
  playback.kill("SIGTERM");
  assert(["completed", "partial"].includes(stopped.phase));
  assert(stopped.finalization_ms !== null && stopped.finalization_ms < 30_000);
  await pluginFiber.update({ data_dir: dataRoot, punctuation_enabled: mode === "enhanced" });
  return { ...await postMeeting(started.meeting_id), draftRevision: live.revision,
    draftElapsedMs, draftFresh: !live.stale, selectionChangeDidNotRestart: true,
    audioThroughMs: live.audio_through_ms, finalizationMs: stopped.finalization_ms };
}

try {
  for (const name of ["dsh-agent", "dsh-system-prompt", "dsh-tools", "dsh-user-approval",
    "dsh-jobs-local", "dsh-subprocess-local"]) await context.plugin((await loadHost(name)).default);
  await context.plugin(ToolJobs, { completionDelivery: "quiet" });
  context.on("approval/request", () => Promise.resolve("allowed-once"));
  context.provide("connection", { rpc: { handle(_channel, handler) {
    rpc = handler; return async () => { rpc = undefined; };
  } } });
  agentFiber = context.plugin(() => undefined);
  agent.ctx = agentFiber.ctx;
  context.agents.register(agent);
  pluginFiber = await context.plugin(plugin, { data_dir: dataRoot,
    ...(mode === "enhanced" ? { punctuation_enabled: true } : {}) });
  phase = "import";
  const imported = await importMeeting();
  phase = "recording";
  const recording = await recordMeeting();
  process.stdout.write(`${JSON.stringify({ ok: true, mode, imported, recording })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, mode, phase, code: error?.code ?? "MODEL_MODE_JOURNEY_FAILED", assertion: error?.operator })}\n`);
  process.exitCode = 1;
} finally {
  playback?.kill("SIGTERM");
  await pluginFiber?.dispose();
  await agentFiber?.dispose();
  await context.fiber.dispose();
}
