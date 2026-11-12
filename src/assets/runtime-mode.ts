import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isParakeetAsset, isPunctuationAsset, isSharedAsset, modelPackFingerprint } from "./model-pack.js";
import { createProcessingIdentity } from "./processing-identity.js";
import type { AsrEngine, ProcessingMode } from "./processing-identity.js";
import type { DoctorRuntimeLayout } from "./runtime-assets-doctor.js";
import { RuntimeAssetsError } from "./runtime-assets-error.js";
import { currentRuntime, verifyAssetAtRoot } from "./runtime-asset-verifier.js";
import { AssetVerificationError } from "./verify-assets.js";
import { installationState } from "./runtime-assets-installation.js";
import type { ModelPackKind } from "./model-pack.js";

function recognitionPackOf(engine: AsrEngine): ModelPackKind {
  return engine === "parakeet" ? "parakeet" : "base";
}

/**
 * Whether a manifest asset participates in the selected engine's run.
 * Parakeet needs its transducer files plus the shared acoustic assets and the
 * native feature/cluster addons; it never touches Paraformer or punctuation
 * weights.
 */
function usesAsset(asset: { id: string; kind: string }, mode: ProcessingMode, engine: AsrEngine): boolean {
  if (asset.kind === "native") return true;
  if (engine === "parakeet") return isParakeetAsset(asset) || isSharedAsset(asset);
  return !isParakeetAsset(asset) && (mode === "enhanced" || !isPunctuationAsset(asset));
}

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
  engine: AsrEngine = "paraformer",
  signal?: AbortSignal,
) {
  const identity = createProcessingIdentity(layout.manifest, layout.engineFingerprint, mode, engine);
  const modelRoot = await selectedModelRoot(layout, layout.modelStoreRoot, recognitionPackOf(engine));
  const punctuationRoot = mode === "enhanced" && engine !== "parakeet"
    ? await selectedModelRoot(layout, layout.modelStoreRoot, "punctuation") : null;
  const runtime = currentRuntime();
  try {
    for (const asset of layout.manifest.assets) {
      if (!usesAsset(asset, mode, engine)) continue;
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
  engine: AsrEngine = "paraformer",
  signal?: AbortSignal,
): Promise<ProcessingMode> {
  // Parakeet casing and punctuation come from the model, so it always runs the
  // punctuated (enhanced) block path without a punctuation pack.
  if (engine === "parakeet") return "enhanced";
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
