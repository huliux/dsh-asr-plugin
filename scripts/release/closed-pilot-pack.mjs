import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { posix } from "node:path";

import { ClosedPilotNativeReleaseError } from "./closed-pilot-native-error.mjs";
import { CLOSED_PILOT_NATIVE_ASSETS, REBUILT_FBANK_MANIFEST } from "./native-release-inventory.mjs";

const EXPECTED_NATIVE_PATHS = CLOSED_PILOT_NATIVE_ASSETS.map(
  (asset) => `dist/${asset.relativePath}`,
);
const FBANK_DISCLOSURE_FILES = [
  "dist/assets/manifest.json",
  "dist/assets/supply-chain.json",
  "THIRD_PARTY_NOTICES.md",
  "LICENSE",
  "third_party/licenses/MIT-node-addon-api.md",
  "third_party/licenses/Ooura-FFT.txt",
];
export const CLOSED_PILOT_EXECUTABLE_PATHS = Object.freeze([
  "dist/recording-helper/DSHASRRecordingHelper.app/Contents/MacOS/DSHASRRecordingHelper",
  "dist/recording-helper/DSHASRRecordingHelper.app/Contents/Helpers/dsh-asr-capture-mic",
  "dist/recording-helper/DSHASRRecordingHelper.app/Contents/Helpers/dsh-asr-capture-system",
]);
const ALLOWED_ROOT_DIRECTORIES = new Set(["dist", "third_party"]);
const ALLOWED_ROOT_FILES = new Set([
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "CONTRIBUTING.md",
  "THIRD_PARTY_NOTICES.md",
  "cordis.patch.yml",
  "package.json",
]);
const PUBLIC_GUIDES = new Set([
  "docs/model-assets.md", "docs/development.md", "docs/publishing.md",
]);
const FORBIDDEN_SEGMENTS = new Set([
  "build",
  "data",
  "meetings",
  "maintenance",
  "models",
  "private-audio",
  "probes",
  "release-staging",
]);
const FORBIDDEN_EXTENSION =
  /\.(?:aac|bin|ckpt|db|flac|m4a|mp3|onnx|opus|pt|pth|safetensors|sqlite(?:-journal|-shm|-wal)?|wav)$/i;

export async function verifyClosedPilotPackInventory({ packedPaths, repositoryRoot }) {
  if (!Array.isArray(packedPaths) || packedPaths.some((path) => typeof path !== "string")) {
    throw invalidPack("pnpm pack did not return a string path inventory");
  }
  if (new Set(packedPaths).size !== packedPaths.length) {
    throw invalidPack("package inventory contains duplicate members");
  }
  const forbiddenPath = packedPaths.find(isForbiddenPath);
  if (forbiddenPath !== undefined) {
    throw invalidPack(`package inventory contains forbidden member: ${forbiddenPath}`);
  }
  const nativePaths = packedPaths.filter((path) => path.endsWith(".node"));
  if (!samePaths(nativePaths, EXPECTED_NATIVE_PATHS)) {
    throw invalidPack("package must contain exactly the two pinned native members");
  }
  const assets = await Promise.all(CLOSED_PILOT_NATIVE_ASSETS.map(async (asset) => {
    const path = `dist/${asset.relativePath}`;
    const identity = await identifyRegularFile(repositoryRoot, path, asset.id);
    if (identity.byteLength !== asset.byteLength || identity.sha256 !== asset.sha256) {
      throw invalidPack(`packed ${asset.id} bytes do not match release policy`, undefined, asset.id);
    }
    return { path, ...identity };
  }));
  return { assets };
}

export async function verifyPackedExecutableModes({ executablePaths, packageRoot }) {
  if (
    !Array.isArray(executablePaths)
    || executablePaths.length === 0
    || executablePaths.some((path) => typeof path !== "string" || isUnsafeRelativePath(path))
    || new Set(executablePaths).size !== executablePaths.length
  ) {
    throw invalidPack("packed executable inventory is invalid");
  }
  for (const relativePath of executablePaths) {
    await assertPackedExecutable(packageRoot, relativePath);
  }
  return { executablePaths };
}

export async function verifyPackedFbankDisclosure({ packageRoot }) {
  try {
    const files = new Map(await Promise.all(FBANK_DISCLOSURE_FILES.map(async (path) =>
      [path, await readPackedText(packageRoot, path)])));
    const manifest = JSON.parse(files.get("dist/assets/manifest.json"));
    const supplyChain = JSON.parse(files.get("dist/assets/supply-chain.json"));
    const runtime = manifest.assets?.filter((item) => item.id === "fbank-native");
    const supply = supplyChain.assets?.filter((item) => item.id === "fbank-native");
    if (runtime?.length !== 1 || JSON.stringify(runtime[0]) !== JSON.stringify(REBUILT_FBANK_MANIFEST)
      || supply?.length !== 1 || !matchesFbankSupply(supply[0])) {
      throw new Error("packed fbank metadata differs from source rebuild policy");
    }
    const notice = files.get("THIRD_PARTY_NOTICES.md");
    if (!notice.includes("github.com/csukuangfj/kaldi-native-fbank — fbank-native")
      || !notice.includes("third_party/licenses/Ooura-FFT.txt")
      || notice.includes("Legacy fbank binary from Bitbook")
      || !files.get("LICENSE").includes("Apache License")
      || !files.get("third_party/licenses/MIT-node-addon-api.md").includes("MIT License")
      || !files.get("third_party/licenses/Ooura-FFT.txt").includes("Copyright Takuya OOURA")) {
      throw new Error("packed fbank notices or license material changed");
    }
    return { assetId: "fbank-native", disclosureFiles: FBANK_DISCLOSURE_FILES.length };
  } catch (cause) {
    throw invalidPack("cannot verify packed fbank source and license disclosure", cause,
      "fbank-native");
  }
}

function matchesFbankSupply(value) {
  return value?.sourceMode === "rebuild"
    && value.canonicalRepository === "https://github.com/csukuangfj/kaldi-native-fbank"
    && value.revision === "fdc395d24dc3e9e48ae1df4f0f6860f6b7d4870e"
    && value.sourcePath === "kaldi-native-fbank/csrc"
    && value.license === "Apache-2.0 AND MIT AND LicenseRef-Ooura-FFT"
    && value.distribution === "public"
    && JSON.stringify(value.buildTarget) === JSON.stringify({
      platform: "darwin", architecture: "arm64", napi: 10,
    })
    && JSON.stringify(value.transports) === JSON.stringify([{ kind: "vendored-source" }])
    && JSON.stringify(value.licenseFiles) === JSON.stringify([
      "LICENSE", "third_party/licenses/MIT-node-addon-api.md",
      "third_party/licenses/Ooura-FFT.txt",
    ]);
}

async function readPackedText(packageRoot, relativePath) {
  const file = await open(posix.resolve(packageRoot, relativePath),
    constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error("package member is not a regular file");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

async function assertPackedExecutable(packageRoot, relativePath) {
  let file;
  try {
    file = await open(posix.resolve(packageRoot, relativePath),
      constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o111) !== 0o111) {
      throw invalidPack(`packed executable lost its executable mode: ${relativePath}`);
    }
  } catch (cause) {
    if (cause instanceof ClosedPilotNativeReleaseError) throw cause;
    throw invalidPack(`cannot verify packed executable: ${relativePath}`, cause);
  } finally {
    if (file !== undefined) await file.close();
  }
}

async function identifyRegularFile(repositoryRoot, relativePath, assetId) {
  let file;
  try {
    file = await open(posix.resolve(repositoryRoot, relativePath),
      constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("package member is not a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let byteLength = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      byteLength += bytesRead;
    }
    return { byteLength, sha256: hash.digest("hex") };
  } catch (cause) {
    if (cause instanceof ClosedPilotNativeReleaseError) throw cause;
    throw invalidPack(`cannot verify packed ${assetId}`, cause, assetId);
  } finally {
    if (file !== undefined) await file.close();
  }
}

function isForbiddenPath(path) {
  if (isUnsafeRelativePath(path)) {
    return true;
  }
  if (path === "locale/en.json" || path === "locale/zh.json" || PUBLIC_GUIDES.has(path)) return false;
  const segments = path.split("/");
  const root = segments[0];
  if (root === undefined) return true;
  const allowedRoot = segments.length === 1
    ? ALLOWED_ROOT_FILES.has(root)
    : ALLOWED_ROOT_DIRECTORIES.has(root);
  if (!allowedRoot) return true;
  return segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))
    || FORBIDDEN_EXTENSION.test(path);
}

function isUnsafeRelativePath(path) {
  return path.length === 0
    || path.includes("\\")
    || path.startsWith("/")
    || posix.normalize(path) !== path;
}

function samePaths(actual, expected) {
  return actual.length === expected.length && expected.every((path) => actual.includes(path));
}

function invalidPack(message, cause, assetId) {
  return new ClosedPilotNativeReleaseError(
    "RELEASE_PACK_INVALID",
    message,
    { assetId, cause },
  );
}
