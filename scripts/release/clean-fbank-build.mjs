import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ClosedPilotNativeReleaseError } from "./closed-pilot-native-error.mjs";
import { appleBuildEnvironment } from "./apple-build-environment.mjs";

const SOURCE_FILES = Object.freeze([
  "binding.gyp",
  "src/fbank_napi.cpp",
  ...[
    "feature-fbank.cc", "feature-fbank.h", "feature-functions.cc",
    "feature-functions.h", "feature-window.cc", "feature-window.h",
    "fftsg.cc", "kaldi-math.cc", "kaldi-math.h", "log.cc", "log.h",
    "mel-computations.cc", "mel-computations.h", "rfft.cc", "rfft.h",
  ].map((name) => `vendor/kaldi-native-fbank/csrc/${name}`),
]);
const NODE_ADDON_API_VERSION = "8.5.0";
const NODE_GYP_VERSION = "12.4.0";

export async function buildReproducibleFbank({ destinationPath, expectedIdentity, repositoryRoot }) {
  assertRuntime();
  await assertSourceFiles(repositoryRoot);
  const toolchain = await resolveToolchain(repositoryRoot);
  const buildRoots = await Promise.all([
    mkdtemp(join(tmpdir(), "dsh-asr-fbank-build-a-")),
    mkdtemp(join(tmpdir(), "dsh-asr-fbank-build-b-")),
  ]);
  try {
    const results = await Promise.all(buildRoots.map((buildRoot) =>
      buildOnce({ buildRoot, repositoryRoot, toolchain })));
    assertReproducible(results, expectedIdentity);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(results[0].binaryPath, destinationPath);
    await chmod(destinationPath, 0o755);
    return results[0].identity;
  } finally {
    await Promise.all(buildRoots.map((root) => rm(root, { force: true, recursive: true })));
  }
}

async function assertSourceFiles(repositoryRoot) {
  const sourceRoot = resolve(repositoryRoot, "native/fbank");
  await Promise.all(SOURCE_FILES.map(async (path) => {
    try {
      const stat = await lstat(resolve(sourceRoot, path));
      if (!stat.isFile()) throw new Error("not a regular file");
    } catch (cause) {
      throw buildError(`invalid fbank source: ${path}`, cause);
    }
  }));
}

function assertRuntime() {
  if (process.platform !== "darwin" || process.arch !== "arm64" ||
    Number(process.versions.node.split(".")[0]) !== 24 || process.versions.napi !== "10") {
    throw buildError("fbank release build requires macOS arm64, Node 24 and N-API 10");
  }
}

async function resolveToolchain(repositoryRoot) {
  const addonRoot = resolve(repositoryRoot, "node_modules/node-addon-api");
  const gypRoot = resolve(repositoryRoot, "node_modules/node-gyp");
  const [addon, gyp] = await Promise.all([
    readPackageJson(resolve(addonRoot, "package.json")),
    readPackageJson(resolve(gypRoot, "package.json")),
  ]);
  if (addon.version !== NODE_ADDON_API_VERSION || gyp.version !== NODE_GYP_VERSION) {
    throw buildError("fbank release build toolchain versions changed");
  }
  let environment;
  try { environment = appleBuildEnvironment(); }
  catch (cause) { throw buildError(cause.message, cause); }
  return { addonRoot, gypScript: resolve(gypRoot, "bin/node-gyp.js"), environment };
}

async function readPackageJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw buildError("cannot read pinned fbank build toolchain", cause);
  }
}

async function buildOnce({ buildRoot, repositoryRoot, toolchain }) {
  if ((await readdir(buildRoot)).length !== 0) throw buildError("fbank build root is not clean");
  await copyInputs({ buildRoot, repositoryRoot, toolchain });
  await runProcess(process.execPath, [toolchain.gypScript, "rebuild"], buildRoot, toolchain.environment);
  const binaryPath = resolve(buildRoot, "build/Release/fbank.node");
  await runProcess("/usr/bin/strip", ["-S", binaryPath], buildRoot, toolchain.environment);
  const bytes = await readFile(binaryPath);
  return { binaryPath, bytes, identity: identify(bytes) };
}

async function copyInputs({ buildRoot, repositoryRoot, toolchain }) {
  const sourceRoot = resolve(repositoryRoot, "native/fbank");
  await Promise.all(SOURCE_FILES.map(async (path) => {
    const source = resolve(sourceRoot, path);
    const target = resolve(buildRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }));
  const addonTarget = resolve(buildRoot, "node_modules/node-addon-api");
  await mkdir(dirname(addonTarget), { recursive: true });
  await cp(toolchain.addonRoot, addonTarget, { dereference: true, recursive: true });
  const stat = await lstat(addonTarget);
  const addon = await readPackageJson(resolve(addonTarget, "package.json"));
  if (!stat.isDirectory() || addon.version !== NODE_ADDON_API_VERSION) {
    throw buildError("materialized node-addon-api changed");
  }
}

function assertReproducible(results, expected) {
  const [first, second] = results;
  if (first === undefined || second === undefined || !first.bytes.equals(second.bytes) ||
    !sameIdentity(first.identity, expected) || !sameIdentity(second.identity, expected)) {
    throw new ClosedPilotNativeReleaseError("RELEASE_BINARY_MISMATCH",
      "two clean fbank builds did not reproduce the pinned release binary",
      { assetId: "fbank-native" });
  }
}

function runProcess(command, args, cwd, env) {
  return new Promise((fulfill, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "ignore", "ignore"] });
    child.once("error", (cause) => reject(buildError("fbank build command failed", cause)));
    child.once("close", (code) => code === 0 ? fulfill() :
      reject(buildError(`fbank build command failed with status ${String(code)}`)));
  });
}

function identify(bytes) {
  return { byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

function sameIdentity(actual, expected) {
  return actual.byteLength === expected.byteLength && actual.sha256 === expected.sha256;
}

function buildError(message, cause) {
  return new ClosedPilotNativeReleaseError("RELEASE_BUILD_FAILED", message,
    { assetId: "fbank-native", cause });
}
