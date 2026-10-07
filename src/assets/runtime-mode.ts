import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isPunctuationAsset, modelPackFingerprint } from "./model-pack.js";
import { createProcessingIdentity } from "./processing-identity.js";
import type { ProcessingMode } from "./processing-identity.js";
import type { DoctorRuntimeLayout } from "./runtime-assets-doctor.js";
import { RuntimeAssetsError } from "./runtime-assets-error.js";
import { currentRuntime, verifyAssetAtRoot } from "./runtime-asset-verifier.js";
import { AssetVerificationError } from "./verify-assets.js";
import { installationState } from "./runtime-assets-installation.js";
import type { ModelPackKind } from "./model-pack.js";

export async function selectedModelRoot(
  layout: Pick<DoctorRuntimeLayout, "manifest" | "modelRoot">,
  modelStoreRoot: string,
  pack: ModelPackKind,
): Promise<string> {
  const root = join(modelStoreRoot, modelPackFingerprint(layout.manifest, pack));
  try {
    await lstat(root);
    return root;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return layout.modelRoot;
    throw error;
  }
}

export async function resolveProcessingAssets(
  layout: DoctorRuntimeLayout & { modelStoreRoot: string },
  mode: ProcessingMode,
  signal?: AbortSignal,
) {
  const identity = createProcessingIdentity(layout.manifest, layout.engineFingerprint, mode);
  const modelRoot = await selectedModelRoot(layout, layout.modelStoreRoot, "base");
  const punctuationRoot = mode === "enhanced"
    ? await selectedModelRoot(layout, layout.modelStoreRoot, "punctuation") : null;
  const runtime = currentRuntime();
  try {
    for (const asset of layout.manifest.assets) {
      if (mode === "base" && isPunctuationAsset(asset)) continue;
      const root = asset.kind === "native" ? layout.packagedNativeRoot
        : isPunctuationAsset(asset) ? punctuationRoot! : modelRoot;
      await verifyAssetAtRoot(root, asset, runtime, signal);
    }
  } catch (error) {
    if (!(error instanceof AssetVerificationError)) throw error;
    throw new RuntimeAssetsError("MODEL_NOT_READY",
      "Selected assets are unavailable; run dsh-asr-assets doctor and restage the affected pack",
      error.assetId);
  }
  return { engineFingerprint: identity.engineFingerprint, modelRoot,
    processing: Object.freeze({ identity, punctuationRoot }) };
}


export async function configuredProcessingMode(
  layout: Pick<DoctorRuntimeLayout, "modelRoot" | "manifest"> & { modelStoreRoot: string },
  signal?: AbortSignal,
): Promise<ProcessingMode> {
  const assets = layout.manifest.assets.filter(isPunctuationAsset);
  if (assets.length === 0) return await installationState(layout, signal) === "ready" ? "enhanced" : "base";
  const root = await selectedModelRoot(layout, layout.modelStoreRoot, "punctuation");
  if (root !== layout.modelRoot) return "enhanced";
  for (const asset of assets) {
    try {
      await lstat(join(root, asset.relativePath));
      return "enhanced";
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return "base";
}
