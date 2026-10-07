import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--version" || args[2] !== "--output") {
  throw new Error("usage: pnpm pack:release --version 0.1.2 --output /absolute/new-directory");
}
const [version, destination] = [args[1], args[3]];
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error("a stable semantic version is required");
}
if (!isAbsolute(destination) || destination === root || destination.startsWith(`${root}/`)) {
  throw new Error("output must be an absolute new directory outside the checkout");
}
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.private !== true) throw new Error("development manifest must retain private: true");
if (!manifest.keywords?.includes("dsh-plugin")
  || manifest.repository?.url !== "git+https://github.com/huliux/dsh-asr-plugin.git"
  || manifest.homepage !== "https://github.com/huliux/dsh-asr-plugin#readme"
  || manifest.bugs?.url !== "https://github.com/huliux/dsh-asr-plugin/issues") {
  throw new Error("public discovery and support metadata is incomplete");
}
const temporary = await mkdtemp(join(tmpdir(), "dsh-asr-public-pack-"));
let outputCreated = false;
try {
  run(process.execPath, ["scripts/verify-closed-pilot-pack.mjs"], root);
  const original = JSON.parse(run("pnpm", ["pack", "--json", "--pack-destination", temporary], root));
  run("/usr/bin/tar", ["-xzf", original.filename, "-C", temporary], root);
  const stage = join(temporary, "package");
  const releaseManifest = { ...manifest, version };
  delete releaseManifest.private;
  await writeFile(join(stage, "package.json"), `${JSON.stringify(releaseManifest, null, 2)}\n`);
  for (const path of ["README.md", "README.zh-CN.md", "docs/distribution.md"]) {
    const text = await readFile(join(stage, path), "utf8");
    await writeFile(join(stage, path), text.replaceAll(
      `@huliux/dsh-asr-plugin@${manifest.version}`, `@huliux/dsh-asr-plugin@${version}`,
    ));
  }
  const output = join(temporary, "release");
  await mkdir(output);
  const pack = JSON.parse(run("pnpm", ["pack", "--json", "--pack-destination", output], stage));
  const verification = JSON.parse(run(process.execPath,
    ["scripts/verify-closed-pilot-pack.mjs", "--archive", pack.filename], root));
  const bytes = await readFile(pack.filename);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const filename = basename(pack.filename);
  const report = {
    name: manifest.name, version, filename, byteLength: bytes.length, sha256,
    sourceCommit: run("git", ["rev-parse", "HEAD"], root).trim(),
    sourceDirty: run("git", ["status", "--porcelain", "--untracked-files=normal"], root).trim() !== "",
    verification, files: pack.files,
  };
  await mkdir(destination);
  outputCreated = true;
  await copyFile(pack.filename, join(destination, filename));
  await writeFile(join(destination, "SHA256SUMS"), `${sha256}  ${filename}\n`);
  await writeFile(join(destination, "release.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...report, files: undefined })}\n`);
} catch (error) {
  if (outputCreated) await rm(destination, { recursive: true, force: true });
  throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function run(command, commandArgs, cwd) {
  return execFileSync(command, commandArgs, {
    cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
