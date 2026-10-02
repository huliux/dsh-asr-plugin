import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  modelSetFingerprint,
  modelPackAssets,
  modelPackFingerprint,
  parseModelPackManifest,
} from "./model-pack.js";
import type { ModelPackKind, ModelPackManifest, ModelPackMaterial } from "./model-pack.js";
import { readSupplyChainManifest } from "./supply-chain.js";
import {
  AssetVerificationError,
  assertAssetPathDirectories,
  mapAssetPathError,
  readAssetManifest,
  resolveAssetPath,
} from "./verify-assets.js";
import type { AssetManifest, AssetRecord } from "./verify-assets.js";
import {
  failModelPackBuildInvalid,
  fileSystemErrorCode,
} from "./model-pack-build-error.js";
import type { OpenModelPackFile } from "./model-pack-archive-writer.js";
import { writeModelPackArchive } from "./model-pack-archive-writer.js";

export { ModelPackBuildError } from "./model-pack-build-error.js";
export type { ModelPackBuildErrorCode } from "./model-pack-build-error.js";

const MAX_LEGAL_FILES = 64;

export interface BuildModelPackInput {
  readonly pack?: ModelPackKind;
  readonly modelRoot: string;
  readonly outputPath: string;
  readonly packageRoot: string;
}

export interface BuildModelPackResult {
  readonly archiveByteLength: number;
  readonly archiveSha256: string;
  readonly assetCount: number;
  readonly modelBytes: number;
  readonly modelSetFingerprint: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failInvalid(message: string): never {
  return failModelPackBuildInvalid(message);
}

async function hashFile(handle: FileHandle, byteLength: number, assetId: string): Promise<string> {
  const hash = createHash("sha256");
  let position = 0;
  while (position < byteLength) {
    const chunk = Buffer.allocUnsafe(Math.min(1_024 * 1_024, byteLength - position));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) break;
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position !== byteLength) {
    throw new AssetVerificationError(
      "ASSET_SIZE_MISMATCH",
      `Asset changed during model pack build: ${assetId}`,
      assetId,
    );
  }
  return hash.digest("hex");
}

async function openRegularFile(path: string, assetId: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const mapped = mapAssetPathError(error, assetId);
    if (mapped !== undefined) throw mapped;
    throw error;
  }
  const file = await handle.stat();
  if (!file.isFile()) {
    await handle.close();
    throw new AssetVerificationError(
      "ASSET_PATH_INVALID",
      `Asset is not a regular file: ${assetId}`,
      assetId,
    );
  }
  return handle;
}

async function openModelFile(root: string, asset: AssetRecord): Promise<OpenModelPackFile> {
  await assertAssetPathDirectories(root, asset);
  const handle = await openRegularFile(resolveAssetPath(root, asset), asset.id);
  try {
    const file = await handle.stat();
    if (file.size !== asset.byteLength) {
      throw new AssetVerificationError(
        "ASSET_SIZE_MISMATCH",
        `Asset size mismatch: ${asset.id}`,
        asset.id,
      );
    }
    const sha256 = await hashFile(handle, file.size, asset.id);
    if (sha256 !== asset.sha256) {
      throw new AssetVerificationError(
        "ASSET_HASH_MISMATCH",
        `Asset hash mismatch: ${asset.id}`,
        asset.id,
      );
    }
    return { assetId: asset.id, handle, ...asset };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function collectThirdPartyFiles(root: string, relativeDirectory: string): Promise<string[]> {
  const directory = join(root, relativeDirectory);
  try {
    const entry = await lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      failInvalid("Package legal material contains an invalid directory");
    }
  } catch (error) {
    if (relativeDirectory === "third_party" && fileSystemErrorCode(error) === "ENOENT") return [];
    throw error;
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (relativeDirectory === "third_party" && fileSystemErrorCode(error) === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await collectThirdPartyFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      failInvalid("Package legal material must contain only regular files and directories");
    }
  }
  return files;
}

async function openMaterial(packageRoot: string, relativePath: string): Promise<OpenModelPackFile> {
  const handle = await openRegularFile(join(packageRoot, relativePath), relativePath);
  try {
    const file = await handle.stat();
    const sha256 = await hashFile(handle, file.size, relativePath);
    return {
      assetId: relativePath,
      byteLength: file.size,
      handle,
      relativePath,
      sha256,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openLegalMaterials(packageRoot: string, pack?: ModelPackKind): Promise<OpenModelPackFile[]> {
  const paths = [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    ...await collectThirdPartyFiles(packageRoot, "third_party"),
    ...(pack === undefined ? [] : ["dist/assets/supply-chain.json"]),
  ].sort(compareText);
  if (paths.length > MAX_LEGAL_FILES) failInvalid("Package contains too many legal files");
  const files: OpenModelPackFile[] = [];
  try {
    for (const path of paths) files.push(await openMaterial(packageRoot, path));
    return files;
  } catch (error) {
    await closeFiles(files);
    throw error;
  }
}

function packAsset(asset: AssetRecord): AssetRecord {
  return {
    id: asset.id,
    kind: asset.kind,
    relativePath: asset.relativePath,
    byteLength: asset.byteLength,
    sha256: asset.sha256,
  };
}

function packMaterial(file: OpenModelPackFile): ModelPackMaterial {
  return {
    relativePath: file.relativePath,
    byteLength: file.byteLength,
    sha256: file.sha256,
  };
}

function createManifest(
  runtime: AssetManifest,
  assets: readonly AssetRecord[],
  materials: readonly OpenModelPackFile[],
  kind?: ModelPackKind,
): { bytes: Buffer; fingerprint: string } {
  const fingerprint = modelPackFingerprint(runtime, kind);
  const pack: ModelPackManifest = {
    ...(kind === undefined ? { schemaVersion: 1 as const } : {
      schemaVersion: 2 as const, packKind: kind,
      compatibilityFingerprint: modelSetFingerprint(runtime),
    }),
    modelSetFingerprint: fingerprint,
    assets: assets.map(packAsset),
    materials: materials.map(packMaterial),
  };
  const bytes = Buffer.from(JSON.stringify(pack), "utf8");
  parseModelPackManifest(bytes, runtime);
  return { bytes, fingerprint };
}

async function closeFiles(files: readonly OpenModelPackFile[]): Promise<void> {
  await Promise.allSettled(files.map(async ({ handle }) => handle.close()));
}

export async function buildModelPack(input: BuildModelPackInput): Promise<BuildModelPackResult> {
  const packageRoot = resolve(input.packageRoot);
  const runtime = await readAssetManifest(join(packageRoot, "dist", "assets", "manifest.json"));
  if (input.pack !== undefined) {
    const source = await readSupplyChainManifest({
      runtimeManifestPath: join(packageRoot, "dist/assets/manifest.json"),
      supplyChainPath: join(packageRoot, "dist/assets/supply-chain.json"),
    });
    const ids = new Set(modelPackAssets(runtime, input.pack).map(({ id }) => id));
    if (source.assets.some((asset) => ids.has(asset.id) && asset.distribution !== "public")) {
      failInvalid("Split model packs require public source facts");
    }
  }
  const assets = modelPackAssets(runtime, input.pack);
  const openFiles: OpenModelPackFile[] = [];
  try {
    for (const asset of assets) openFiles.push(await openModelFile(resolve(input.modelRoot), asset));
    const materials = await openLegalMaterials(packageRoot, input.pack);
    openFiles.push(...materials);
    const manifest = createManifest(runtime, assets, materials, input.pack);
    const archive = await writeModelPackArchive(
      resolve(input.outputPath),
      manifest.bytes,
      openFiles,
    );
    return {
      ...archive,
      assetCount: assets.length,
      modelBytes: assets.reduce((sum, asset) => sum + asset.byteLength, 0),
      modelSetFingerprint: manifest.fingerprint,
    };
  } finally {
    await closeFiles(openFiles);
  }
}
