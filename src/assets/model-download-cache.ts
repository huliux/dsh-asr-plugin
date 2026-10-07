import { constants } from "node:fs";
import { copyFile, lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AssetVerificationError, assertAssetPathDirectories, verifyAssetsAtRoots } from "./verify-assets.js";
import type { AssetRecord } from "./verify-assets.js";
import { ModelDownloadError } from "./model-download-contract.js";
import type { ModelDownloadPack } from "./model-download-contract.js";

export async function prepareDownloadCache(dataRoot: string, pack: ModelDownloadPack): Promise<string> {
  const parent = join(dataRoot, ".model-download-cache");
  const root = join(parent, pack);
  for (const directory of [parent, root]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new ModelDownloadError("ASSET_PATH_INVALID");
  }
  return root;
}

export async function restoreDownloadedAsset(root: string, manifestPath: string, asset: AssetRecord,
  destination: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  try {
    await verifyAssetsAtRoots({ manifestPath, modelRoot: root, packagedNativeRoot: root, assetIds: [asset.id] });
  } catch (error) {
    if (!(error instanceof AssetVerificationError) ||
      !["ASSET_MISSING", "ASSET_HASH_MISMATCH", "ASSET_SIZE_MISMATCH"].includes(error.code)) throw error;
    return false;
  }
  signal.throwIfAborted();
  await copyFile(join(root, asset.relativePath), destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  return true;
}

export async function retainDownloadedAsset(root: string, asset: AssetRecord, source: string): Promise<void> {
  const destination = join(root, asset.relativePath);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await assertAssetPathDirectories(root, asset);
  const temporary = `${destination}.${randomUUID()}`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}
