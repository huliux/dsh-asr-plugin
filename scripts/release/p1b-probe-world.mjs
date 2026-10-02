import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const INPUTS = [
  ["input_code_tgz", "codeTgz"],
  ["input_model_pack", "modelPack"],
  ["input_wav", "wav"],
  ["input_m4a", "m4a"],
  ["input_mp3", "mp3"],
];

export async function inspectRegularFile(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const file = await handle.stat();
    if (!file.isFile()) return { errorCode: "ARTIFACT_NOT_REGULAR" };
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return { byteLength: file.size, sha256: hash.digest("hex") };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { errorCode: "ARTIFACT_MISSING" };
    }
    return { errorCode: "ARTIFACT_UNREADABLE" };
  } finally {
    await handle?.close();
  }
}

function inputPath(input, key) {
  return ["wav", "m4a", "mp3"].includes(key) ? input.audio[key] : input[key];
}

export async function inspectInputs(input) {
  const checks = [];
  const artifacts = {};
  for (const [id, key] of INPUTS) {
    const inspection = await inspectRegularFile(inputPath(input, key));
    if (inspection.errorCode !== undefined) {
      checks.push({ id, status: "failed", error_code: inspection.errorCode });
    } else {
      checks.push({ id, status: "passed" });
      artifacts[id] = { byte_length: inspection.byteLength, sha256: inspection.sha256 };
    }
  }
  return { artifacts, checks };
}

export async function writeReport(path, report) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function copyInputs(input, artifactRoot) {
  const paths = {};
  for (const [, key] of INPUTS) {
    const source = inputPath(input, key);
    const suffix = key === "codeTgz" ? ".tgz" : key === "modelPack" ? ".tar" : `.${key}`;
    const target = join(artifactRoot, `${key}-${randomUUID()}${suffix}`);
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600);
    paths[key] = target;
  }
  return paths;
}

function isolatedEnvironment(root) {
  const env = {
    ...process.env,
    DSH_HOME: join(root, "dsh-home"),
    DSH_AGENTS_HOME: join(root, "agents-home"),
    PNPM_HOME: join(root, "pnpm-home"),
    TMPDIR: join(root, "tmp"),
    XDG_CACHE_HOME: join(root, "cache"),
    npm_config_cache: join(root, "npm-cache"),
    npm_config_store_dir: join(root, "pnpm-store"),
  };
  delete env.NODE_PATH;
  delete env.INIT_CWD;
  delete env.DEEPSEEK_API_KEY;
  return env;
}

export async function prepareWorld(input, options = {}) {
  const parent = options.parent ?? tmpdir();
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, options.prefix ?? "dsh-asr-p1b-installed-"));
  const directories = [
    "artifacts",
    "workspace",
    "tmp",
    "cache",
    "npm-cache",
    "pnpm-home",
    "pnpm-store",
    "agents-home",
  ];
  for (const directory of directories) {
    await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
  }
  return {
    root,
    artifacts: await copyInputs(input, join(root, "artifacts")),
    env: isolatedEnvironment(root),
    workspace: join(root, "workspace"),
  };
}
