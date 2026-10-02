import { createHash } from "node:crypto";
import { chmod, copyFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertAbiMismatch,
  assertStageFailures,
} from "./p1b-probe-assets.mjs";
import { pluginExec, step } from "./p1b-probe-checks.mjs";
import {
  parseJsonLine,
  ProbeFailure,
  runCommand,
  runRequired,
  startObservedCommand,
  stopProcessTree,
} from "./p1b-probe-process.mjs";
import { inspectRegularFile } from "./p1b-probe-world.mjs";

const HOST_HELPER = fileURLToPath(new URL("./probe-installed-host.mjs", import.meta.url));

async function digestTree(root) {
  const hash = createHash("sha256");
  async function visit(path, relative) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : 1)) {
      const childRelative = join(relative, entry.name);
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) {
        const inspected = await inspectRegularFile(child);
        if (inspected.errorCode !== undefined) throw new ProbeFailure("DATA_TREE_UNREADABLE");
        hash.update(`${childRelative}\0${inspected.byteLength}\0${inspected.sha256}\n`);
      } else throw new ProbeFailure("DATA_TREE_INVALID");
    }
  }
  await visit(root, "");
  return hash.digest("hex");
}

export async function installedDataDigest(dataRoot) {
  const hash = createHash("sha256");
  for (const name of ["assets", "db", "meetings"]) {
    hash.update(`${name}:${await digestTree(join(dataRoot, name))}\n`);
  }
  return hash.digest("hex");
}

export async function startWeb(dsh, world) {
  const observed = await startObservedCommand(
    dsh, ["web", "--no-open", "--port", "0"],
    { ...world, timeoutMs: 120_000 }, /dsh web: http:\/\//,
  );
  const url = /dsh web: (http:\/\/[^\s]+)/.exec(observed.output())?.[1];
  if (url === undefined) {
    await stopProcessTree(observed.child);
    throw new ProbeFailure("WEB_READY_URL_MISSING");
  }
  return { ...observed, url, request: () => requestAuthenticatedWeb(url) };
}

async function requestAuthenticatedWeb(url) {
  const login = await fetch(url, { redirect: "manual" });
  if (login.status < 300 || login.status >= 400) return login;
  const location = login.headers.get("location");
  if (location === null) return login;
  const target = new URL(location, url);
  if (target.origin !== new URL(url).origin) throw new ProbeFailure("WEB_AUTH_REDIRECT_INVALID");
  const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  return fetch(target, { headers: { cookie }, redirect: "manual" });
}

async function prepareInstalledHost(context, forbiddenSourceMarkers) {
  const { profileRoot, world } = context;
  const runner = join(profileRoot, "p1b-installed-host.mjs");
  await copyFile(HOST_HELPER, runner);
  await copyFile(fileURLToPath(new URL("./installed-host-modules.mjs", import.meta.url)),
    join(profileRoot, "installed-host-modules.mjs"));
  await chmod(runner, 0o600);
  const dataRoot = join(world.env.DSH_HOME, "dsh-asr-plugin");
  const hostEnv = {
    ...world.env,
    P1B_DATA_ROOT: dataRoot,
    P1B_AUDIO_WAV: world.artifacts.wav,
    P1B_AUDIO_M4A: world.artifacts.m4a,
    P1B_AUDIO_MP3: world.artifacts.mp3,
    P1B_PROFILE_ROOT: profileRoot,
    P1B_DSH_HOST_ENTRY: process.env.P1B_DSH_HOST_ENTRY ?? context.dsh,
    P1B_FORBIDDEN_PATHS: JSON.stringify(forbiddenSourceMarkers),
  };
  return { dataRoot, hostEnv, runner };
}

export function installedHostWitness(result) {
  const witness = parseJsonLine(result.stdout, "INSTALLED_HOST_REPORT_INVALID");
  if (result.code === 0 && witness.status === "passed") return witness;
  const errorCode = typeof witness.error_code === "string" &&
    /^[A-Z][A-Z0-9_]+$/.test(witness.error_code)
    ? witness.error_code
    : "INSTALLED_HOST_E2E_FAILED";
  throw new ProbeFailure(errorCode);
}

async function exerciseInstalledHost(context, host, checks) {
  return step(checks, "installed_host_eight_tools_workers_addons", async () => {
    const exercised = await runCommand(process.execPath, [host.runner, "exercise"], {
      ...context.world,
      env: host.hostEnv,
      cwd: context.profileRoot,
      timeoutMs: 3_600_000,
    });
    return { ...installedHostWitness(exercised), maxRssBytes: exercised.maxRssBytes };
  });
}

async function proveLeaseOverlap(context, host, checks) {
  const rejection = /DATA_ROOT_IN_USE|MeetingRepositoryError: Meeting data root is already in use/;
  const owner = await step(checks, "first_host_processing", () => startObservedCommand(
    process.execPath, [host.runner, "lease-owner"],
    { ...context.world, env: host.hostEnv, cwd: context.profileRoot, timeoutMs: 900_000 },
    /"event":"processing"/));
  try {
    await step(checks, "second_host_rejected_during_processing", async () => {
      const contender = await startObservedCommand(context.dsh,
        ["web", "--no-open", "--port", "0"],
        { ...context.world, timeoutMs: 120_000 }, rejection);
      try {
        if (!rejection.test(contender.output()) ||
          owner.output().includes('"event":"committed"')) {
          throw new ProbeFailure("SECOND_HOST_OVERLAP_NOT_PROVEN");
        }
        return { rejectedPlugin: true };
      } finally { await stopProcessTree(contender.child); }
    });
    await step(checks, "first_host_commits_after_rejection", async () => {
      const outcome = await owner.done;
      const result = parseJsonLine(owner.output(), "LEASE_OWNER_REPORT_INVALID");
      if (outcome.code !== 0 || result.status !== "passed" || result.event !== "committed") {
        throw new ProbeFailure("FIRST_HOST_DID_NOT_COMMIT");
      }
    });
  } finally { await stopProcessTree(owner.child); }
}

async function verifyInstalledRuntimeFailures(context, host, checks) {
  const web = await step(checks, "web_no_open", () => startWeb(context.dsh, context.world));
  try {
    if ((await web.request()).status !== 200 || web.output().includes("opening the default browser")) {
      throw new ProbeFailure("WEB_NO_OPEN_FAILED");
    }
  } finally { await stopProcessTree(web.child); }
  await step(checks, "negative_asset_and_interrupt_cases",
    () => assertStageFailures(context.dsh, context.world, context.doctor,
      context.stagedModelFingerprint));
  await step(checks, "native_abi_mismatch",
    () => assertAbiMismatch(context.packageRoot, host.dataRoot, context.world));
}

async function removeAndReinstall(context, dataRoot, checks, before) {
  const { dsh, world } = context;
  await step(checks, "plugin_remove", () => runRequired(dsh,
    ["plugin", "--profile", "web", "remove", "@huliux/dsh-asr-plugin",
      "--store-dir", join(world.root, "pnpm-store")],
    { ...world, timeoutMs: 600_000 }, "PLUGIN_REMOVE_FAILED"));
  if (await installedDataDigest(dataRoot) !== before) {
    throw new ProbeFailure("UNINSTALL_CHANGED_USER_DATA");
  }
  await step(checks, "plugin_reinstall", () => runRequired(dsh,
    ["plugin", "--profile", "web", "add", "--ignore-scripts", world.artifacts.codeTgz,
      "--store-dir", join(world.root, "pnpm-store")],
    { ...world, timeoutMs: 600_000 }, "PLUGIN_REINSTALL_FAILED"));
}

async function verifyReinstallation(context, host, checks, witness, before) {
  const { dsh, profileRoot, world } = context;
  await removeAndReinstall(context, host.dataRoot, checks, before);
  await step(checks, "doctor_after_reinstall", async () => {
    const result = await runRequired(dsh, pluginExec("doctor"), world,
      "DOCTOR_AFTER_REINSTALL_FAILED");
    const report = parseJsonLine(result.stdout, "DOCTOR_INVALID_JSON");
    if (!report.ready || report.modelSetFingerprint !== context.doctor.modelSetFingerprint) {
      throw new ProbeFailure("REINSTALLED_ASSETS_NOT_READY");
    }
    return result;
  });
  const env = {
    ...host.hostEnv,
    P1B_MEETING_ID: witness.retained_meeting_id,
    P1B_MEETING_STATUS: witness.retained_status,
  };
  await step(checks, "reinstall_preserves_data", () => runRequired(process.execPath,
    [host.runner, "verify-persistence"],
    { ...world, env, cwd: profileRoot, timeoutMs: 300_000 }, "PERSISTENCE_VERIFY_FAILED"));
  if (await installedDataDigest(host.dataRoot) !== before) {
    throw new ProbeFailure("REINSTALL_CHANGED_USER_DATA");
  }
}

export async function assertNoProbeProcesses(world) {
  const listed = await runRequired("/bin/ps", ["-axo", "pid=,command="], world,
    "PROCESS_AUDIT_FAILED");
  if (listed.stdout.split("\n").some((line) => line.includes(world.root))) {
    throw new ProbeFailure("PROBE_PROCESS_LEFT_RUNNING");
  }
}

export async function runInstalledProductChecks(context, checks, forbiddenSourceMarkers) {
  // Verify actual host boot before exercising installed tools.
  await step(checks, "installed_host_bootstrap", async () => {
    const web = await startWeb(context.dsh, context.world);
    try {
      if ((await web.request()).status !== 200) throw new ProbeFailure("HOST_BOOTSTRAP_FAILED");
    } finally {
      await stopProcessTree(web.child);
    }
  });
  const host = await prepareInstalledHost(context, forbiddenSourceMarkers);
  const witness = await exerciseInstalledHost(context, host, checks);
  await proveLeaseOverlap(context, host, checks);
  const before = await installedDataDigest(host.dataRoot);
  await verifyInstalledRuntimeFailures(context, host, checks);
  await verifyReinstallation(context, host, checks, witness, before);
  await step(checks, "no_live_probe_processes", () => assertNoProbeProcesses(context.world));
  return host;
}
