import { createProcessingIdentity } from "../assets/processing-identity.js";
import { isPunctuationAsset } from "../assets/model-pack.js";
import {
  fingerprintAssetManifest,
  readAssetManifest,
  verifyAssetsAtRoots,
} from "../assets/verify-assets.js";
import type { WorkerEntryConfig } from "./entry-config.js";
import { WorkerRuntimeError } from "./worker-errors.js";

export interface VerifiedWorkerAssets {
  readonly engineFingerprint: string;
  readonly paths: Readonly<Record<string, string>>;
}

export async function loadWorkerAssets(
  config: WorkerEntryConfig,
  requiredIds: readonly string[],
): Promise<VerifiedWorkerAssets> {
  let engineFingerprint = await fingerprintAssetManifest(config.manifestPath);
  const processing = config.processing;
  if (processing !== undefined) {
    const expected = createProcessingIdentity(await readAssetManifest(config.manifestPath),
      engineFingerprint, processing.identity.mode);
    if (Object.entries(expected).some(([key, value]) =>
      processing.identity[key as keyof typeof expected] !== value)) {
      throw new WorkerRuntimeError("ASSET_MISMATCH", "Worker processing identity changed");
    }
    engineFingerprint = expected.engineFingerprint;
  }
  const paths = await verifyAssetsAtRoots({
    assetIds: processing?.identity.mode === "base"
      ? requiredIds.filter((id) => !isPunctuationAsset({ id })) : requiredIds,
    ...(processing?.punctuationRoot == null ? {} : { punctuationRoot: processing.punctuationRoot }),
    modelRoot: config.modelRoot,
    packagedNativeRoot: config.packagedNativeRoot,
    manifestPath: config.manifestPath,
  });
  return { engineFingerprint, paths };
}

export function requiredAsset(
  assets: Readonly<Record<string, string>>,
  id: string,
): string {
  const path = assets[id];
  if (path === undefined) {
    throw new WorkerRuntimeError("ASSET_MISMATCH", "Required Worker asset is missing");
  }
  return path;
}
