import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = resolve(repositoryRoot, "native/fbank");
const binaryPath = resolve(nativeRoot, "build/Release/fbank.node");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed (${String(result.status)}): ${command}`);
  }
}

function assertBuildRuntime() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    nodeMajor !== 24 ||
    Number(process.versions.napi) < 8
  ) {
    throw new Error("fbank build requires macOS arm64, Node 24 and Node-API 8+");
  }
}

assertBuildRuntime();
run(process.execPath, [
  resolve(repositoryRoot, "node_modules/node-gyp/bin/node-gyp.js"),
  "rebuild",
  "--directory",
  nativeRoot,
]);
run("/usr/bin/strip", ["-S", binaryPath]);

const binary = await readFile(binaryPath);
console.log(JSON.stringify({
  path: relative(repositoryRoot, binaryPath),
  byteLength: binary.byteLength,
  sha256: createHash("sha256").update(binary).digest("hex"),
  node: process.versions.node,
  napi: Number(process.versions.napi),
}));
