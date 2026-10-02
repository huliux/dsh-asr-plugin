import {
  readFile,
  appendFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pluginExec, step } from "./p1b-probe-checks.mjs";
import { runInstalledProductChecks } from "./p1b-probe-host.mjs";
import {
  parseJsonLine,
  ProbeFailure,
  runCommand,
  runRequired,
} from "./p1b-probe-process.mjs";
import {
  inspectInputs,
  inspectRegularFile,
  prepareWorld,
  writeReport,
} from "./p1b-probe-world.mjs";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FORBIDDEN_SOURCE_MARKERS = [
  SOURCE_ROOT,
  join("Projects", "clerki"),
  join("Application Support", "Bitbook"),
];
async function dshExecutable(env, cwd) {
  const explicit = process.env.P1B_DSH_BIN;
  if (explicit !== undefined) return realpath(explicit);
  const found = await runRequired("/usr/bin/which", ["dsh"], { env, cwd }, "DSH_NOT_FOUND");
  return realpath(found.stdout.trim());
}

async function profilePackageRoot(world) {
  return realpath(join(world.env.DSH_HOME, "profiles", "web", "node_modules", "@huliux/dsh-asr-plugin"));
}

function installedOrtIntegrity(value) {
  const dependency = value?.dependencies?.find?.((entry) =>
    entry?.id === "onnxruntime-node" &&
    entry?.packageName === "onnxruntime-node" &&
    entry?.version === "1.19.2");
  return typeof dependency?.integrity === "string" &&
    /^sha512-[A-Za-z0-9+/]{86}==$/u.test(dependency.integrity)
    ? dependency.integrity
    : undefined;
}

export async function verifyInstalledOrtIntegrity({ packageRoot, profileRoot }) {
  try {
    const supplyChain = JSON.parse(await readFile(
      join(packageRoot, "dist/assets/supply-chain.json"),
      "utf8",
    ));
    const integrity = installedOrtIntegrity(supplyChain);
    const lockText = await readFile(join(profileRoot, "pnpm-lock.yaml"), "utf8");
    if (integrity === undefined || !lockText.includes(integrity)) {
      throw new ProbeFailure("ORT_INTEGRITY_NOT_LOCKED");
    }
    return integrity;
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure("ORT_INTEGRITY_NOT_LOCKED");
  }
}

async function assertBundleAndIsolation(world) {
  const profileRoot = join(world.env.DSH_HOME, "profiles", "web");
  const manifest = JSON.parse(await readFile(join(profileRoot, "package.json"), "utf8"));
  if (!manifest.dsh?.profile?.bundles?.includes("@huliux/dsh-asr-plugin")) {
    throw new ProbeFailure("BUNDLE_NOT_ACTIVE");
  }
  const packageRoot = await profilePackageRoot(world);
  const isolatedRoot = await realpath(world.root);
  const sourceRoot = await realpath(SOURCE_ROOT);
  if (!packageRoot.startsWith(`${isolatedRoot}/`) || packageRoot.startsWith(`${sourceRoot}/`)) {
    throw new ProbeFailure("SOURCE_PATH_LEAK");
  }
  const lockText = await readFile(join(profileRoot, "pnpm-lock.yaml"), "utf8");
  const workspaceText = await readFile(join(profileRoot, "pnpm-workspace.yaml"), "utf8");
  for (const forbidden of FORBIDDEN_SOURCE_MARKERS) {
    if (lockText.includes(forbidden)) throw new ProbeFailure("FORBIDDEN_PATH_LEAK");
  }
  if (workspaceText.includes("set this to true or false")) {
    throw new ProbeFailure("PNPM_BUILD_APPROVAL_REQUIRED");
  }
  if ((await readdir(join(world.root, "pnpm-store"))).length === 0) {
    throw new ProbeFailure("ISOLATED_STORE_UNUSED");
  }
  return packageRoot;
}

async function collectNativeFacts(packageRoot) {
  const manifest = JSON.parse(await readFile(join(packageRoot, "dist/assets/manifest.json"), "utf8"));
  const facts = [];
  for (const asset of manifest.assets.filter((entry) => entry.kind === "native")) {
    const inspected = await inspectRegularFile(join(packageRoot, "dist", asset.relativePath));
    if (inspected.errorCode !== undefined || inspected.sha256 !== asset.sha256) {
      throw new ProbeFailure("PACKAGED_NATIVE_INVALID");
    }
    facts.push({ id: asset.id, byte_length: inspected.byteLength, sha256: inspected.sha256 });
  }
  return facts;
}

async function machineFacts(dsh, world) {
  const [version, macos, chip, dshFile] = await Promise.all([
    runRequired(dsh, ["--version"], world, "DSH_VERSION_FAILED"),
    runRequired("/usr/bin/sw_vers", ["-productVersion"], world, "MACOS_VERSION_FAILED"),
    runCommand("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"], world),
    inspectRegularFile(dsh),
  ]);
  return {
    node_version: process.versions.node,
    node_napi: Number(process.versions.napi),
    architecture: process.arch,
    platform: process.platform,
    memory_bytes: totalmem(),
    macos_version: macos.stdout.trim(),
    chip: chip.code === 0 ? chip.stdout.trim() : "unknown",
    dsh_version: version.stdout.trim(),
    dsh_sha256: dshFile.sha256,
  };
}

function runtimeChecks(environment) {
  const [macosMajor, macosMinor = 0] = environment.macos_version.split(".").map(Number);
  const supported = environment.platform === "darwin" && environment.architecture === "arm64" &&
    Number(environment.node_version.split(".")[0]) === 24 &&
    (macosMajor > 13 || (macosMajor === 13 && macosMinor >= 5));
  return [
    supported
      ? { id: "supported_engineering_runtime", status: "passed" }
      : { id: "supported_engineering_runtime", status: "failed", error_code: "RUNTIME_UNSUPPORTED" },
    { id: "p1b06_external_m1_m2_16g", status: "skipped", error_code: "EXTERNAL_PRODUCT_GATE_PENDING" },
  ];
}

export async function configureIsolatedDependencyPolicy(profileRoot, storeRoot) {
  await appendFile(join(profileRoot, "pnpm-workspace.yaml"),
    `\nstoreDir: ${JSON.stringify(storeRoot)}\nallowBuilds:\n  "onnxruntime-node@1.19.2": false\n`);
}

async function installPlugin(dsh, world, checks) {
  await step(checks, "dsh_plugin_add", async () => {
    const added = await runRequired(dsh,
      ["plugin", "--profile", "web", "add", "--ignore-scripts", world.artifacts.codeTgz,
        "--store-dir", join(world.root, "pnpm-store")],
      { ...world, timeoutMs: 600_000 }, "PLUGIN_ADD_FAILED");
    if (`${added.stdout}\n${added.stderr}`.includes("ERR_PNPM_IGNORED_BUILDS")) {
      throw new ProbeFailure("PNPM_BUILD_APPROVAL_REQUIRED");
    }
    return added;
  });
}

async function configureInstalledAssets(context, checks, report) {
  const { dsh, packageRoot, profileRoot, world } = context;
  const integrity = await step(checks, "ort_integrity_locked", () =>
    verifyInstalledOrtIntegrity({ packageRoot, profileRoot }));
  const dumped = await step(checks, "dump_config", () => runRequired(dsh,
    ["--profile", "web", "--dump-config"], world, "DUMP_CONFIG_FAILED"));
  if (!dumped.stdout.includes("@huliux/dsh-asr-plugin")) throw new ProbeFailure("DUMP_CONFIG_MISSING_PLUGIN");
  const staged = await step(checks, "assets_stage", async () => assertAssetCommand(await runCommand(dsh,
    pluginExec("stage", world.artifacts.modelPack),
    { ...world, timeoutMs: 900_000 }), "ASSETS_STAGE_FAILED"));
  const command = await step(checks, "assets_doctor", () => runRequired(dsh,
    pluginExec("doctor"), { ...world, timeoutMs: 300_000 }, "ASSETS_DOCTOR_FAILED"));
  const doctor = parseJsonLine(command.stdout, "DOCTOR_INVALID_JSON");
  if (!doctor.ready) throw new ProbeFailure("ASSETS_NOT_READY");
  report.runtime = {
    model_set_fingerprint: doctor.modelSetFingerprint,
    engine_fingerprint: doctor.engineFingerprint,
    onnxruntime_node_npm_integrity: integrity,
    native: await collectNativeFacts(packageRoot),
  };
  const stage = parseJsonLine(staged.stdout, "STAGE_INVALID_JSON");
  if (typeof stage.modelSetFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(stage.modelSetFingerprint)) {
    throw new ProbeFailure("STAGE_FINGERPRINT_INVALID");
  }
  return { doctor, stagedModelFingerprint: stage.modelSetFingerprint };
}

export function assertAssetCommand(result, fallback) {
  if (result.code === 0) return result;
  let code = fallback;
  try {
    const parsed = JSON.parse(result.stderr.trim().split("\n").filter(Boolean).at(-1) ?? "");
    if (typeof parsed?.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(parsed.code)) {
      code = parsed.code;
    }
  } catch {}
  throw new ProbeFailure(code);
}

export async function prepareInstalledRuntime(world, checks, report) {
  const dsh = await dshExecutable(world.env, world.workspace);
  report.environment = await machineFacts(dsh, world);
  report.install_policy = {
    dependency_scripts: "disabled_for_add_then_ort_explicitly_denied",
    reason_code: "ORT_DARWIN_PREBUILT_HASH_AND_INFERENCE_VERIFIED",
  };
  checks.push(...runtimeChecks(report.environment));
  await installPlugin(dsh, world, checks);
  await configureIsolatedDependencyPolicy(join(world.env.DSH_HOME, "profiles", "web"),
    join(world.root, "pnpm-store"));
  const packageRoot = await step(checks, "bundle_and_source_isolation",
    () => assertBundleAndIsolation(world));
  const profileRoot = join(world.env.DSH_HOME, "profiles", "web");
  const context = { dsh, packageRoot, profileRoot, world };
  const assets = await configureInstalledAssets(context, checks, report);
  return { ...context, ...assets };
}

async function runMainline(input, checks, report) {
  const world = await prepareWorld(input);
  try {
    const context = await prepareInstalledRuntime(world, checks, report);
    await runInstalledProductChecks(context, checks, FORBIDDEN_SOURCE_MARKERS);
  } finally {
    await rm(world.root, { force: true, recursive: true });
  }
}

export async function runInstalledArtifactProbe(input) {
  const inspected = await inspectInputs(input);
  const checks = [...inspected.checks];
  const report = {
    schema_version: 1,
    gate: "p1b-installed-artifact",
    generated_at: new Date().toISOString(),
    engineering_status: "no_go",
    local_engineering_status: "no_go",
    closed_pilot_status: "no_go",
    public_release_status: "no_go",
    artifacts: inspected.artifacts,
    checks,
  };
  if (checks.every((check) => check.status === "passed")) {
    try { await runMainline(input, checks, report); } catch (error) {
      checks.push({ id: "probe_mainline", status: "failed",
        error_code: error instanceof ProbeFailure ? error.code : "UNEXPECTED_FAILURE" });
    }
  }
  const hardFailure = checks.some((check) => check.status === "failed");
  report.local_engineering_status = hardFailure ? "no_go" : "go";
  report.engineering_status = report.local_engineering_status;
  await writeReport(input.reportPath, report);
  return { engineeringStatus: report.engineering_status };
}
