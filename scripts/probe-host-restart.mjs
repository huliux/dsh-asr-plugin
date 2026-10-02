import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openMeetingRepository } from "../dist/storage/meeting-repository.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const scriptPath = fileURLToPath(import.meta.url);

function createProcessingMeeting(filename) {
  const repository = openMeetingRepository(filename);
  repository.createImport({
    meetingId: MEETING_ID,
    title: "Host crash probe",
    sourceName: "probe.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 1_024,
    runId: RUN_ID,
    nowMs: 1_000,
  });
}

async function waitUntilReady(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("READY\n")) resolve();
    });
    child.once("exit", (code, signal) => {
      reject(new Error(`Crash probe child exited before READY: ${code ?? signal}`));
    });
  });
}

async function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function runParent() {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-host-crash-"));
  const filename = join(root, "meetings.sqlite3");
  let child;
  let repository;
  try {
    child = spawn(process.execPath, [scriptPath, "child", filename], {
      cwd: dirname(scriptPath),
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitUntilReady(child);
    const exited = waitForExit(child);
    assert.equal(child.kill("SIGKILL"), true);
    assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });

    repository = openMeetingRepository(filename);
    assert.equal(repository.getMeeting(MEETING_ID)?.status, "processing");
    assert.equal(repository.reconcileOrphanedRuns(2_000), 1);
    assert.deepEqual(
      {
        status: repository.getMeeting(MEETING_ID)?.status,
        errorCode: repository.getMeeting(MEETING_ID)?.errorCode,
        errorStage: repository.getMeeting(MEETING_ID)?.errorStage,
      },
      { status: "failed", errorCode: "ORPHANED_BY_RESTART", errorStage: "startup" },
    );
    process.stdout.write('{"host_crash":"ORPHANED_BY_RESTART","status":"passed"}\n');
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    repository?.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === "child") {
  createProcessingMeeting(process.argv[3]);
  process.stdout.write("READY\n");
  setInterval(() => {}, 60_000);
} else {
  await runParent();
}
