import { stat } from "node:fs/promises";
import { join } from "node:path";

import { step } from "./p1b-probe-checks.mjs";
import {
  assertNoProbeProcesses,
  installedDataDigest,
  installedHostWitness,
  startWeb,
} from "./p1b-probe-host.mjs";
import {
  ProbeFailure,
  runCommand,
  runRequired,
  stopProcessTree,
} from "./p1b-probe-process.mjs";

export function validateRecordingWitness(witness) {
  if (!Number.isSafeInteger(witness?.draft_revision_observed) ||
    witness.draft_revision_observed < 1 ||
    typeof witness.max_finalization_ms !== "number" ||
    !Number.isFinite(witness.max_finalization_ms) || witness.max_finalization_ms < 0 ||
    witness.max_finalization_ms >= 30_000 ||
    witness.first_use_tracks?.join(",") !== "mic,system" ||
    witness.restart_tracks?.join(",") !== "mic,system" ||
    !Array.isArray(witness.result_statuses) || witness.result_statuses.length !== 2 ||
    witness.result_statuses.some((status) => !["completed", "partial", "empty"].includes(status))) {
    throw new ProbeFailure("INSTALLED_RECORDING_WITNESS_INVALID");
  }
  return witness;
}

async function runHostMode(context, host, mode, timeoutMs) {
  const result = await runCommand(process.execPath, [host.runner, mode], {
    ...context.world,
    env: host.hostEnv,
    cwd: context.profileRoot,
    timeoutMs,
  });
  return { ...installedHostWitness(result), maxRssBytes: result.maxRssBytes };
}

async function verifyWeb(context) {
  const web = await startWeb(context.dsh, context.world);
  try {
    const response = await web.request();
    if (response.status !== 200 || web.output().includes("opening the default browser")) {
      throw new ProbeFailure("P1C_DSH_WEB_FAILED");
    }
    return { status: response.status };
  } finally {
    await stopProcessTree(web.child);
  }
}

export async function runP1cInstalledHostChecks(context, host, checks) {
  await step(checks, "installed_client_export", () =>
    runHostMode(context, host, "client-export", 120_000));
  const recording = await step(checks, "installed_signed_dual_recording_restart", async () => {
    const witness = await runHostMode(context, host, "recording", 900_000);
    return validateRecordingWitness(witness);
  });
  await step(checks, "installed_dsh_web_client", () => verifyWeb(context));
  await step(checks, "p1c_host_no_live_processes", () => assertNoProbeProcesses(context.world));
  return recording;
}

async function packageWasRemoved(packageRoot) {
  try {
    await stat(packageRoot);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

export async function verifyP1cUninstall(context, dataRoot, checks) {
  const before = await installedDataDigest(dataRoot);
  await step(checks, "p1c_plugin_uninstall", () => runRequired(context.dsh,
    ["plugin", "--profile", "web", "remove", "@huliux/dsh-asr-plugin",
      "--store-dir", join(context.world.root, "pnpm-store")],
    { ...context.world, timeoutMs: 600_000 }, "P1C_PLUGIN_REMOVE_FAILED"));
  await step(checks, "p1c_uninstall_preserves_recordings", async () => {
    if (await installedDataDigest(dataRoot) !== before) {
      throw new ProbeFailure("P1C_UNINSTALL_CHANGED_USER_DATA");
    }
    if (!await packageWasRemoved(context.packageRoot)) {
      throw new ProbeFailure("P1C_UNINSTALL_LEFT_PACKAGE");
    }
  });
  await step(checks, "p1c_uninstalled_web_starts", () => verifyWeb(context));
  await step(checks, "p1c_uninstall_no_live_processes", () => assertNoProbeProcesses(context.world));
}
