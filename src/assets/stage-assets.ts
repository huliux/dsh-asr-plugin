import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  AssetVerificationError,
  readAssetManifest,
  resolveAssetPath,
  verifyAssets,
} from "./verify-assets.js";
import type { AssetRecord, AssetRuntime } from "./verify-assets.js";

export interface StageAssetsOptions {
  assetRoot: string;
  manifestPath: string;
  runtime?: AssetRuntime;
  sources: Readonly<Record<string, string>>;
}

function inspector(onChunk: (chunk: Buffer) => void): Transform {
  return new Transform({
    transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: TransformCallback,
    ) {
      onChunk(chunk);
      callback(null, chunk);
    },
  });
}

async function copyVerifiedAsset(
  sourcePath: string,
  destinationPath: string,
  asset: AssetRecord,
): Promise<void> {
  const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
  const hash = createHash("sha256");
  let byteLength = 0;
  try {
    await pipeline(
      createReadStream(sourcePath),
      inspector((chunk) => {
        byteLength += chunk.byteLength;
        hash.update(chunk);
      }),
      createWriteStream(temporaryPath, { flags: "wx", flush: true, mode: 0o600 }),
    );
    if (byteLength !== asset.byteLength) {
      throw new AssetVerificationError(
        "ASSET_SIZE_MISMATCH",
        `Asset size mismatch: ${asset.id}`,
        asset.id,
      );
    }
    if (hash.digest("hex") !== asset.sha256) {
      throw new AssetVerificationError(
        "ASSET_HASH_MISMATCH",
        `Asset hash mismatch: ${asset.id}`,
        asset.id,
      );
    }
    await rename(temporaryPath, destinationPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function stageAssets(
  options: StageAssetsOptions,
): Promise<Record<string, string>> {
  const manifest = await readAssetManifest(options.manifestPath);
  const assetRoot = resolve(options.assetRoot);
  for (const asset of manifest.assets) {
    const sourcePath = options.sources[asset.id];
    if (sourcePath === undefined) {
      throw new AssetVerificationError(
        "STAGE_SOURCE_MISSING",
        `Asset source is missing: ${asset.id}`,
        asset.id,
      );
    }
    const destinationPath = resolveAssetPath(assetRoot, asset);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyVerifiedAsset(sourcePath, destinationPath, asset);
  }
  return verifyAssets({
    assetRoot,
    manifestPath: options.manifestPath,
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
  });
}
