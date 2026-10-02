import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = resolve(repositoryRoot, "native/hcluster");
const binaryPath = resolve(nativeRoot, "build/Release/hcluster.node");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (${String(result.status)}): ${command}`);
  }
}

function assertBuildRuntime() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (process.platform !== "darwin" || process.arch !== "arm64" || nodeMajor !== 24) {
    throw new Error("hcluster P0 build requires macOS arm64 and Node 24");
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
console.log(
  JSON.stringify({
    path: relative(repositoryRoot, binaryPath),
    byteLength: binary.byteLength,
    sha256: createHash("sha256").update(binary).digest("hex"),
  }),
);
