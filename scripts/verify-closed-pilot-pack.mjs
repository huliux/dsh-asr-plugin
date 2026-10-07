import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLOSED_PILOT_EXECUTABLE_PATHS,
  ClosedPilotNativeReleaseError,
  verifyClosedPilotPackInventory,
  verifyPackedFbankDisclosure,
  verifyPackedExecutableModes,
} from "./release/closed-pilot-native.mjs";
import { verifyRecordingHelperAssets } from "../dist/assets/recording-helper-assets.js";
import { inspectRecordingHelperSignature } from "../dist/assets/recording-helper-signature.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--archive")) {
    throw new Error("usage: verify-closed-pilot-pack.mjs [--archive /path/to/package.tgz]");
  }
  const report = await inspectReleaseArchive(repositoryRoot, args[1]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  const failure = error instanceof ClosedPilotNativeReleaseError
    ? { code: error.code, ...(error.assetId === undefined ? {} : { assetId: error.assetId }) }
    : { code: "RELEASE_PACK_INVALID" };
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
}

async function inspectReleaseArchive(cwd, archive) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-asr-pack-"));
  try {
    const pack = archive === undefined
      ? await inspectPnpmPack(cwd, temporaryRoot)
      : await inspectExistingArchive(archive, temporaryRoot);
    const inventory = await verifyClosedPilotPackInventory({
      repositoryRoot: cwd,
      packedPaths: pack.files.map((file) => file.path),
    });
    const packageRoot = await extractPackage(pack, temporaryRoot);
    await verifyClosedPilotPackInventory({
      repositoryRoot: packageRoot,
      packedPaths: pack.files.map((file) => file.path),
    });
    const disclosure = await verifyPackedFbankDisclosure({ packageRoot });
    const helper = await verifyPackedHelper(packageRoot);
    const modes = await verifyPackedExecutableModes({
      executablePaths: CLOSED_PILOT_EXECUTABLE_PATHS,
      packageRoot,
    });
    return { ...inventory, disclosure, helper, ...modes, packedFileCount: pack.files.length };
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function inspectExistingArchive(archive, temporaryRoot) {
  const filename = join(temporaryRoot, basename(archive));
  await copyFile(resolve(archive), filename);
  const listing = await runBounded("/usr/bin/tar", ["-tzf", filename], temporaryRoot, true);
  const members = listing.trim().split("\n");
  if (members.some((path) => !path.startsWith("package/") || path.includes("\\")
    || path.split("/").some((part) => part === "." || part === ".."))) {
    throw new Error("archive members must be safe paths under package/");
  }
  const details = await runBounded("/usr/bin/tar", ["-tvzf", filename], temporaryRoot, true);
  if (details.trim().split("\n").some((line) => !/^[d-]/.test(line))) {
    throw new Error("archive may contain only directories and regular files");
  }
  const files = members.filter((path) => !path.endsWith("/"));
  return { filename, files: files.map((path) => ({ path: path.slice("package/".length) })) };
}

async function verifyPackedHelper(packageRoot) {
  const root = join(packageRoot, "dist/recording-helper");
  const verified = await verifyRecordingHelperAssets({
    appRoot: join(root, "DSHASRRecordingHelper.app"),
    manifestPath: join(root, "manifest.json"),
    inspectSignature: (input) => inspectRecordingHelperSignature(input, runCodesign),
  });
  if (verified.signingMode !== "ad-hoc" || verified.teamIdentifier !== null) {
    throw new ClosedPilotNativeReleaseError("RELEASE_PACK_INVALID",
      "packed recording helper is not the public ad-hoc build");
  }
  return { signingMode: verified.signingMode, manifestSha256: verified.manifestSha256 };
}

function runCodesign(args, cwd) {
  return new Promise((fulfill, reject) => {
    const child = spawn("/usr/bin/codesign", args, {
      cwd, stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let size = 0;
    const append = (chunk) => {
      size += chunk.byteLength;
      if (size > 128 * 1024) child.kill();
      else chunks.push(chunk);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("close", (status) => size > 128 * 1024
      ? reject(new Error("codesign output exceeded limit"))
      : fulfill({ status, output: Buffer.concat(chunks).toString("utf8") }));
  });
}

async function inspectPnpmPack(cwd, destination) {
  const stdout = await runBounded("pnpm", [
    "pack",
    "--json",
    "--pack-destination",
    destination,
  ], cwd, true);
  const value = JSON.parse(stdout);
  if (!isPackInventory(value)) {
    throw new ClosedPilotNativeReleaseError(
      "RELEASE_PACK_INVALID",
      "pnpm pack returned an invalid inventory",
    );
  }
  return value;
}

async function extractPackage(pack, temporaryRoot) {
  const archiveName = basename(pack.filename);
  const archivePath = resolve(pack.filename);
  if (archivePath !== join(temporaryRoot, archiveName) || !archiveName.endsWith(".tgz")) {
    throw new ClosedPilotNativeReleaseError(
      "RELEASE_PACK_INVALID",
      "pnpm pack returned an unsafe archive name",
    );
  }
  const extractRoot = join(temporaryRoot, "extract");
  await mkdir(extractRoot);
  await runBounded(
    "/usr/bin/tar",
    ["-xzf", archivePath, "-C", extractRoot],
    temporaryRoot,
    false,
  );
  return join(extractRoot, "package");
}

function runBounded(command, args, cwd, captureStdout) {
  return new Promise((fulfill, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "ignore"],
    });
    const chunks = [];
    let byteLength = 0;
    child.stdout?.on("data", (chunk) => {
      byteLength += chunk.byteLength;
      if (byteLength > 2 * 1024 * 1024) child.kill();
      else chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0 || byteLength > 2 * 1024 * 1024) {
        reject(new Error(`${command} failed`));
      } else {
        fulfill(Buffer.concat(chunks).toString("utf8"));
      }
    });
  });
}

function isPackInventory(value) {
  return typeof value === "object"
    && value !== null
    && typeof value.filename === "string"
    && Array.isArray(value.files)
    && value.files.every((file) =>
      typeof file === "object" && file !== null && typeof file.path === "string");
}
