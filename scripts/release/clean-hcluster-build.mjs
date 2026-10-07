import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { ClosedPilotNativeReleaseError } from "./closed-pilot-native-error.mjs";
import { appleBuildEnvironment } from "./apple-build-environment.mjs";

const HCLUSTER_SOURCE_FILES = Object.freeze([
  "binding.gyp",
  "vendor/fastcluster.cpp",
  "vendor/fastcluster.h",
  "vendor/fastcluster_R_dm.cpp",
  "vendor/fastcluster_dm.cpp",
  "vendor/hcluster_napi.cpp",
]);
const NODE_ADDON_API_VERSION = "8.5.0";
const NODE_GYP_VERSION = "12.4.0";

export async function buildReproducibleHcluster({
  destinationPath,
  expectedIdentity,
  repositoryRoot,
}) {
  assertBuildRuntime();
  const toolchain = await resolveToolchain(repositoryRoot);
  const buildRoots = await Promise.all([
    mkdtemp(join(tmpdir(), "dsh-asr-hcluster-build-a-")),
    mkdtemp(join(tmpdir(), "dsh-asr-hcluster-build-b-")),
  ]);
  assertIndependentAbsoluteRoots(buildRoots);
  try {
    const results = await Promise.all(buildRoots.map(async (buildRoot) =>
      buildOnce({ buildRoot, repositoryRoot, toolchain })));
    assertReproducibleResults(results, expectedIdentity);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(results[0].binaryPath, destinationPath);
    await chmod(destinationPath, 0o755);
    return results[0].identity;
  } finally {
    await Promise.all(buildRoots.map(async (root) => rm(root, {
      force: true,
      recursive: true,
    })));
  }
}

function assertBuildRuntime() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (
    process.platform !== "darwin"
    || process.arch !== "arm64"
    || nodeMajor !== 24
    || process.versions.napi !== "10"
  ) {
    throw buildError("hcluster release build requires macOS arm64, Node 24 and N-API 10");
  }
}

async function resolveToolchain(repositoryRoot) {
  const nodeAddonRoot = resolve(repositoryRoot, "node_modules/node-addon-api");
  const nodeGypRoot = resolve(repositoryRoot, "node_modules/node-gyp");
  const [nodeAddonPackage, nodeGypPackage] = await Promise.all([
    readPackageJson(resolve(nodeAddonRoot, "package.json")),
    readPackageJson(resolve(nodeGypRoot, "package.json")),
  ]);
  if (nodeAddonPackage.version !== NODE_ADDON_API_VERSION) {
    throw buildError(`node-addon-api must be exactly ${NODE_ADDON_API_VERSION}`);
  }
  if (nodeGypPackage.version !== NODE_GYP_VERSION) {
    throw buildError(`node-gyp must be exactly ${NODE_GYP_VERSION}`);
  }
  let environment;
  try { environment = appleBuildEnvironment(); }
  catch (cause) { throw buildError(cause.message, cause); }
  return { nodeAddonRoot, nodeGypScript: resolve(nodeGypRoot, "bin/node-gyp.js"), environment };
}

async function readPackageJson(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null) throw new Error("not an object");
    return value;
  } catch (cause) {
    throw buildError("cannot read pinned hcluster build toolchain", cause);
  }
}

function assertIndependentAbsoluteRoots(buildRoots) {
  if (
    buildRoots.length !== 2
    || !buildRoots.every(isAbsolute)
    || buildRoots[0] === buildRoots[1]
  ) {
    throw buildError("hcluster reproducibility gate requires two distinct absolute build roots");
  }
}

async function buildOnce({ buildRoot, repositoryRoot, toolchain }) {
  if ((await readdir(buildRoot)).length !== 0) {
    throw buildError("hcluster temporary build root is not clean");
  }
  await copyBuildInputs({ buildRoot, repositoryRoot, toolchain });
  await runProcess(process.execPath, [toolchain.nodeGypScript, "rebuild"], buildRoot, toolchain.environment);
  const binaryPath = resolve(buildRoot, "build/Release/hcluster.node");
  await runProcess("/usr/bin/strip", ["-S", binaryPath], buildRoot, toolchain.environment);
  const bytes = await readFile(binaryPath);
  return { binaryPath, bytes, identity: identify(bytes) };
}

async function copyBuildInputs({ buildRoot, repositoryRoot, toolchain }) {
  const sourceRoot = resolve(repositoryRoot, "native/hcluster");
  await Promise.all(HCLUSTER_SOURCE_FILES.map(async (relativePath) => {
    const sourcePath = resolve(sourceRoot, relativePath);
    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isFile()) throw buildError(`invalid hcluster source: ${relativePath}`);
    const targetPath = resolve(buildRoot, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  }));
  const addonTarget = resolve(buildRoot, "node_modules/node-addon-api");
  await mkdir(dirname(addonTarget), { recursive: true });
  await cp(toolchain.nodeAddonRoot, addonTarget, { dereference: true, recursive: true });
  const targetStat = await lstat(addonTarget);
  const targetPackage = await readPackageJson(resolve(addonTarget, "package.json"));
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw buildError("node-addon-api was not physically materialized in the build root");
  }
  if (targetPackage.version !== NODE_ADDON_API_VERSION) {
    throw buildError("materialized node-addon-api version changed");
  }
}

function assertReproducibleResults(results, expectedIdentity) {
  const first = results[0];
  const second = results[1];
  if (
    first === undefined
    || second === undefined
    || !first.bytes.equals(second.bytes)
    || !sameIdentity(first.identity, expectedIdentity)
    || !sameIdentity(second.identity, expectedIdentity)
  ) {
    throw new ClosedPilotNativeReleaseError(
      "RELEASE_BINARY_MISMATCH",
      "two clean hcluster builds did not reproduce the pinned release binary",
      { assetId: "hcluster-native" },
    );
  }
}

async function runProcess(command, args, cwd, env) {
  const result = await collectProcess(command, args, cwd, env);
  if (result.code !== 0) {
    throw buildError(`hcluster build command failed with status ${String(result.code)}`);
  }
}

function collectProcess(command, args, cwd, env) {
  return new Promise((fulfill, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...env,
        MACOSX_DEPLOYMENT_TARGET: "13.5",
        ZERO_AR_DATE: "1",
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", reject);
    child.once("close", (code) => fulfill({ code }));
  });
}

function identify(bytes) {
  return {
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function sameIdentity(actual, expected) {
  return actual.byteLength === expected.byteLength && actual.sha256 === expected.sha256;
}

function buildError(message, cause) {
  return new ClosedPilotNativeReleaseError(
    "RELEASE_BUILD_FAILED",
    message,
    { assetId: "hcluster-native", cause },
  );
}
