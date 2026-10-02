import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { pluginExec } from "./p1b-probe-checks.mjs";
import {
  parseJsonLine,
  ProbeFailure,
  runCommand,
  runRequired,
} from "./p1b-probe-process.mjs";

async function corruptArchive(source, destination) {
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  const handle = await open(destination, "r+");
  try {
    const file = await handle.stat();
    if (file.size < 1024) throw new ProbeFailure("MODEL_PACK_TOO_SMALL");
    const byte = Buffer.alloc(1);
    const position = Math.floor(file.size / 2);
    await handle.read(byte, 0, 1, position);
    byte[0] ^= 0xff;
    await handle.write(byte, 0, 1, position);
  } finally { await handle.close(); }
}

function fileSystemErrorCode(error) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

async function missingAs(action, fallback, acceptedCodes = ["ENOENT"]) {
  try {
    return await action();
  } catch (error) {
    if (acceptedCodes.includes(fileSystemErrorCode(error))) return fallback;
    throw new ProbeFailure("STAGE_OBSERVATION_FAILED");
  }
}

async function modelStoreEntries(dataRoot) {
  return missingAs(() => readdir(join(dataRoot, "assets")), []);
}

export async function partialStageFileVisible(dataRoot) {
  const modelStore = join(dataRoot, "assets");
  const entries = await modelStoreEntries(dataRoot);
  for (const name of entries.filter((entry) => entry.startsWith(".stage-"))) {
    const children = await missingAs(() => readdir(join(modelStore, name), {
      recursive: true, withFileTypes: true,
    }), [], ["ENOENT", "ENOTDIR"]);
    for (const entry of children.filter((child) => child.isFile())) {
      const file = await missingAs(
        () => stat(join(entry.parentPath, entry.name)), undefined, ["ENOENT", "ENOTDIR"],
      );
      if (file?.size > 0) return true;
    }
  }
  return false;
}

async function assertInterruptedStageRecovers(dsh, world, doctor, stagedModelFingerprint) {
  const interruptedRoot = join(world.root, "interrupted-data");
  const interrupted = await runCommand(
    dsh,
    pluginExec("stage", world.artifacts.modelPack, "--data-dir", interruptedRoot),
    {
      ...world,
      interruptSignal: "SIGKILL",
      interruptWhen: () => partialStageFileVisible(interruptedRoot),
      timeoutMs: 900_000,
    },
  );
  if (interrupted.signal !== "SIGKILL") throw new ProbeFailure("STAGE_SIGKILL_NOT_OBSERVED");
  const abandoned = await modelStoreEntries(interruptedRoot);
  if (!abandoned.some((entry) => entry.startsWith(".stage-")) ||
    abandoned.includes(stagedModelFingerprint)) {
    throw new ProbeFailure("STAGE_SIGKILL_STATE_INVALID");
  }
  const recovered = await runRequired(dsh,
    pluginExec("stage", world.artifacts.modelPack, "--data-dir", interruptedRoot),
    { ...world, timeoutMs: 900_000 }, "STAGE_RECOVERY_FAILED");
  const result = parseJsonLine(recovered.stdout, "STAGE_RECOVERY_INVALID_JSON");
  const entries = (await modelStoreEntries(interruptedRoot)).sort();
  if (!result.installed || result.modelSetFingerprint !== stagedModelFingerprint ||
    JSON.stringify(entries) !== JSON.stringify([stagedModelFingerprint])) {
    throw new ProbeFailure("STAGE_RECOVERY_LEFT_RESIDUE");
  }
  const diagnosed = await runRequired(dsh,
    pluginExec("doctor", "--data-dir", interruptedRoot),
    { ...world, timeoutMs: 300_000 }, "STAGE_RECOVERY_DOCTOR_FAILED");
  const recoveredDoctor = parseJsonLine(diagnosed.stdout, "STAGE_RECOVERY_DOCTOR_INVALID_JSON");
  if (!recoveredDoctor.ready ||
    recoveredDoctor.modelSetFingerprint !== doctor.modelSetFingerprint) {
    throw new ProbeFailure("STAGE_RECOVERY_NOT_READY");
  }
}

export async function assertStageFailures(dsh, world, doctor, stagedModelFingerprint) {
  const missing = await runCommand(
    dsh, pluginExec("stage", join(world.root, "absent.tar")), world,
  );
  if (missing.code === 0 || !`${missing.stdout}${missing.stderr}`.includes("MODEL_PACK_INVALID")) {
    throw new ProbeFailure("MISSING_PACK_NOT_REJECTED");
  }
  const corrupt = join(world.root, "artifacts", "corrupt-model-pack.tar");
  await corruptArchive(world.artifacts.modelPack, corrupt);
  const damaged = await runCommand(dsh, pluginExec("stage", corrupt), world);
  if (damaged.code === 0) throw new ProbeFailure("CORRUPT_PACK_ACCEPTED");
  await assertInterruptedStageRecovers(dsh, world, doctor, stagedModelFingerprint);
  const healthy = parseJsonLine((await runRequired(dsh,
    pluginExec("doctor"), world, "DOCTOR_AFTER_FAILURE_FAILED")).stdout, "DOCTOR_INVALID_JSON");
  if (!healthy.ready || healthy.modelSetFingerprint !== doctor.modelSetFingerprint) {
    throw new ProbeFailure("OLD_MODEL_SET_DAMAGED");
  }
}

export async function assertAbiMismatch(packageRoot, dataRoot, world) {
  const fixture = join(world.root, "abi-fixture");
  await cp(packageRoot, fixture, { recursive: true });
  const manifestPath = join(fixture, "dist/assets/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const native = manifest.assets.find((asset) => asset.kind === "native");
  if (native?.runtime === undefined) throw new ProbeFailure("ABI_FIXTURE_INVALID");
  native.runtime.napi = 999;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(join(fixture, "node_modules"), { recursive: true });
  const requireInstalled = createRequire(join(packageRoot, "package.json"));
  const ort = await realpath(dirname(requireInstalled.resolve("onnxruntime-node/package.json")));
  await symlink(ort, join(fixture, "node_modules/onnxruntime-node"), "dir");
  const entry = join(fixture, "dist/assets/runtime-assets.js");
  const runtime = await import(`${pathToFileURL(entry).href}?probe=${randomUUID()}`);
  const report = await runtime.doctorRuntimeAssets({ dataRoot, packageRoot: fixture });
  if (report.ready || !report.issues.some((issue) => issue.code === "RUNTIME_MISMATCH")) {
    throw new ProbeFailure("ABI_MISMATCH_NOT_REJECTED");
  }
}
