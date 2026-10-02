import { link, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { modelSetFingerprint } from "../../src/assets/model-pack.js";
import { currentRuntime, verifyAssetAtRoot } from "../../src/assets/runtime-asset-verifier.js";
import {
  readAssetManifest,
  resolveAssetPath,
} from "../../src/assets/verify-assets.js";
import type { AssetRecord } from "../../src/assets/verify-assets.js";

export interface P1aRuntimeAssetFixtureInput {
  readonly dataRoot: string;
  readonly legacyAssetRoot: string;
  readonly manifestPath: string;
}

export interface P1aRuntimeAssetFixture {
  readonly modelRoot: string;
  readonly modelSetFingerprint: string;
}

function crossDeviceError(source: string, target: string, cause: unknown): Error {
  return new Error(
    `P1a fixture requires hard links on one filesystem: ${source} -> ${target}`,
    { cause },
  );
}

export async function prepareP1aRuntimeAssetFixture(
  input: P1aRuntimeAssetFixtureInput,
): Promise<P1aRuntimeAssetFixture> {
  const manifestPath = resolve(input.manifestPath);
  const manifest = await readAssetManifest(manifestPath);
  const legacyAssetRoot = resolve(input.legacyAssetRoot);
  const sources: Array<{ asset: AssetRecord; source: string }> = [];
  for (const asset of manifest.assets) {
    if (asset.kind === "native") continue;
    await verifyAssetAtRoot(legacyAssetRoot, asset, currentRuntime());
    sources.push({ asset, source: resolveAssetPath(legacyAssetRoot, asset) });
  }
  const fingerprint = modelSetFingerprint(manifest);
  const modelRoot = join(resolve(input.dataRoot), "assets", fingerprint);
  try {
    for (const { asset, source } of sources) {
      const target = resolveAssetPath(modelRoot, asset);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      try {
        await link(source, target);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EXDEV") {
          throw crossDeviceError(source, target, error);
        }
        throw error;
      }
    }
  } catch (error) {
    await rm(modelRoot, { recursive: true, force: true });
    throw error;
  }
  return { modelRoot, modelSetFingerprint: fingerprint };
}
