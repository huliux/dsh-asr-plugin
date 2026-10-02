import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import LocalJobRegistry from "@deepseek-ai/dsh-jobs-local";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import ToolRuntime from "@deepseek-ai/dsh-tools";

import * as plugin from "../dist/index.js";
import { openMeetingRepository } from "../dist/storage/meeting-repository.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = dirname(dirname(scriptPath));

function meetingToolCount(context) {
  return context.tools.schemas().filter(({ name }) => name.startsWith("meeting_")).length;
}

async function createHostContext() {
  const context = new Context();
  await context.plugin(AgentRegistry);
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime);
  await context.plugin(LocalJobRegistry);
  await context.plugin(LocalSubprocessRuntime);
  return context;
}

function withRepository(dataRoot, operation) {
  const repository = openMeetingRepository(join(dataRoot, "db", "meetings.sqlite3"));
  try {
    return operation(repository);
  } finally {
    repository.close();
  }
}

function seedProcessingMeeting(dataRoot) {
  withRepository(dataRoot, (repository) => repository.createImport({
    meetingId: MEETING_ID,
    title: "lease probe",
    sourceName: "probe.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1_024,
    runId: RUN_ID,
    nowMs: 1_000,
  }));
}

function commitProcessingMeeting(dataRoot) {
  return withRepository(dataRoot, (repository) => repository.commitTranscript({
    meetingId: MEETING_ID,
    runId: RUN_ID,
    baseVersion: 0,
    resultStatus: "completed",
    resultReason: null,
    durationMs: 1_000,
    engineFingerprint: "a".repeat(64),
    segments: [{
      seq: 0,
      startMs: 0,
      endMs: 1_000,
      speakerLabel: "Speaker A",
      text: "probe",
    }],
    nowMs: 2_000,
  }));
}

async function runChild(role, dataRoot) {
  const context = await createHostContext();
  let fiber;
  try {
    fiber = await context.plugin(plugin, {
      data_dir: dataRoot,
    });
    if (role === "owner") seedProcessingMeeting(dataRoot);
    process.send?.({ type: "startup", outcome: "loaded", tools: meetingToolCount(context) });
  } catch (error) {
    process.send?.({
      type: "startup",
      outcome: "error",
      code: typeof error === "object" && error !== null && "code" in error ? error.code : null,
      tools: meetingToolCount(context),
    });
  }
  const host = { context, dataRoot, fiber };
  process.on("message", (message) => {
    void handleChildMessage(message, host);
  });
}

async function handleChildMessage(message, host) {
  if (typeof message !== "object" || message === null || !("type" in message)) return;
  if (message.type === "status") {
    const meeting = withRepository(host.dataRoot, (repository) => repository.getMeeting(MEETING_ID));
    process.send?.({ type: "status", status: meeting?.status ?? null, error_code: meeting?.errorCode ?? null });
    return;
  }
  if (message.type === "commit") {
    const result = commitProcessingMeeting(host.dataRoot);
    process.send?.({ type: "commit", outcome: result.outcome, status: result.meeting.status });
    return;
  }
  if (message.type === "reload") {
    if (typeof message.data_root !== "string") throw new Error("Reload data root is missing");
    await host.fiber?.update({
      data_dir: message.data_root,
    });
    host.dataRoot = message.data_root;
    process.send?.({ type: "reload", outcome: "loaded", tools: meetingToolCount(host.context) });
    return;
  }
  if (message.type !== "stop") return;
  await host.fiber?.dispose();
  await host.context.fiber.dispose();
  process.disconnect?.();
}

function spawnHost(role, dataRoot) {
  return fork(scriptPath, ["child", role, dataRoot], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
}

function waitForMessage(child, type, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${type}`)), timeoutMs);
    const onExit = (code, signal) => finish(new Error(`Host exited before ${type}: ${code ?? signal}`));
    const onMessage = (message) => {
      if (typeof message === "object" && message !== null && message.type === type) finish(undefined, message);
    };
    const finish = (error, value) => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("message", onMessage);
      if (error === undefined) resolve(value);
      else reject(error);
    };
    child.once("exit", onExit);
    child.on("message", onMessage);
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Host did not stop in time")), timeoutMs);
    const onExit = (code, signal) => finish(undefined, [code, signal]);
    const finish = (error, value) => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      if (error === undefined) resolve(value);
      else reject(error);
    };
    child.once("exit", onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send({ type: "stop" });
  await waitForExit(child, 5_000);
}

async function forceStopChild(child) {
  try {
    await stopChild(child);
  } catch {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
}

function request(child, type, payload = {}) {
  const response = waitForMessage(child, type);
  child.send({ type, ...payload });
  return response;
}

async function expectLoaded(child) {
  assert.deepEqual(await waitForMessage(child, "startup"), {
    type: "startup", outcome: "loaded", tools: 5,
  });
}

async function expectRejected(child) {
  assert.deepEqual(await waitForMessage(child, "startup"), {
    type: "startup", outcome: "error", code: "DATA_ROOT_IN_USE", tools: 0,
  });
}

async function runGracefulScenarios(initialRoot, reloadRoot, children) {
  const owner = spawnHost("owner", initialRoot);
  children.push(owner);
  await expectLoaded(owner);
  const contender = spawnHost("contender", initialRoot);
  children.push(contender);
  await expectRejected(contender);
  assert.deepEqual(await request(owner, "status"), {
    type: "status", status: "processing", error_code: null,
  });
  assert.deepEqual(await request(owner, "commit"), {
    type: "commit", outcome: "committed", status: "completed",
  });

  assert.deepEqual(await request(owner, "reload", { data_root: reloadRoot }), {
    type: "reload", outcome: "loaded", tools: 5,
  });
  const releasedRootSuccessor = spawnHost("contender", initialRoot);
  children.push(releasedRootSuccessor);
  await expectLoaded(releasedRootSuccessor);
  const reloadContender = spawnHost("contender", reloadRoot);
  children.push(reloadContender);
  await expectRejected(reloadContender);
  await stopChild(owner);
  const successor = spawnHost("contender", reloadRoot);
  children.push(successor);
  await expectLoaded(successor);
}

async function runCrashScenario(dataRoot, children) {
  const owner = spawnHost("owner", dataRoot);
  children.push(owner);
  await expectLoaded(owner);
  const exited = once(owner, "exit");
  assert.equal(owner.kill("SIGKILL"), true);
  assert.deepEqual(await exited, [null, "SIGKILL"]);

  const recovery = spawnHost("recovery", dataRoot);
  children.push(recovery);
  await expectLoaded(recovery);
  assert.deepEqual(await request(recovery, "status"), {
    type: "status", status: "failed", error_code: "ORPHANED_BY_RESTART",
  });
}

async function runParent() {
  const initialRoot = await mkdtemp(join(tmpdir(), "dsh-asr-data-root-lease-"));
  const reloadRoot = await mkdtemp(join(tmpdir(), "dsh-asr-data-root-reload-"));
  const crashRoot = await mkdtemp(join(tmpdir(), "dsh-asr-data-root-crash-"));
  const children = [];
  try {
    await runGracefulScenarios(initialRoot, reloadRoot, children);
    await runCrashScenario(crashRoot, children);
    process.stdout.write('{"data_root_lease":"concurrent_release_reload_sigkill","status":"passed"}\n');
  } finally {
    await Promise.all(children.map(forceStopChild));
    await Promise.all([initialRoot, reloadRoot, crashRoot]
      .map((root) => rm(root, { recursive: true, force: true })));
  }
}

if (process.argv[2] === "child") await runChild(process.argv[3], process.argv[4]);
else await runParent();
