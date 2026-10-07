import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { modelPackAssets } from "./model-pack.js";
import { buildModelPack } from "./model-pack-builder.js";
import { stageModelPack } from "./runtime-assets.js";
import { readSupplyChainManifest } from "./supply-chain.js";
import { readAssetManifest } from "./verify-assets.js";
import { ModelDownloadError, customModelProxy } from "./model-download-contract.js";
import type { ModelDownloadPack, ModelDownloadSettings, ModelDownloadStatus } from "./model-download-contract.js";
import { modelDownloadSources } from "./model-download-sources.js";
import { downloadModelFile } from "./model-download-transport.js";
import type { ModelDownloadTransport } from "./model-download-transport.js";
import { prepareDownloadCache, restoreDownloadedAsset, retainDownloadedAsset } from "./model-download-cache.js";

export interface ModelDownloadOperationInput {
  readonly dataRoot: string;
  readonly packageRoot: string;
  readonly pack: ModelDownloadPack;
  readonly settings: ModelDownloadSettings;
  readonly transport: ModelDownloadTransport;
  readonly signal: AbortSignal;
  readonly update: (value: Partial<ModelDownloadStatus>) => void;
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ModelDownloadError("MODEL_DOWNLOAD_CANCELLED");
}

async function receiveModels(input: ModelDownloadOperationInput, root: string, cache: string): Promise<void> {
  const paths = { runtimeManifestPath: join(input.packageRoot, "dist/assets/manifest.json"),
    supplyChainPath: join(input.packageRoot, "dist/assets/supply-chain.json") };
  const manifest = await readAssetManifest(paths.runtimeManifestPath);
  const sources = await readSupplyChainManifest(paths);
  const assets = modelPackAssets(manifest, input.pack);
  const totalBytes = assets.reduce((sum, asset) => sum + asset.byteLength, 0);
  input.update({ phase: "downloading", totalBytes, downloadedBytes: 0 });
  let received = 0;
  for (const asset of assets) {
    cancelled(input.signal);
    const source = sources.assets.find(value => value.id === asset.id);
    if (source === undefined) throw new ModelDownloadError("MODEL_DOWNLOAD_SOURCE_INVALID");
    const [first, ...fallbacks] = modelDownloadSources(source, input.settings);
    if (first === undefined) throw new ModelDownloadError("MODEL_DOWNLOAD_SOURCE_INVALID");
    const destination = join(root, "models", asset.relativePath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    if (!await restoreDownloadedAsset(cache, paths.runtimeManifestPath, asset, destination, input.signal)) {
      try {
        await downloadModelFile(input.transport, { ...first, fallbacks, destination, expectedBytes: asset.byteLength,
          expectedSha256: asset.sha256, workRoot: root, signal: input.signal,
          progress: bytes => input.update({ downloadedBytes: received + bytes }) });
      } catch (error) {
        if (!(error instanceof ModelDownloadError) || error.code !== "MODEL_DOWNLOAD_FAILED") throw error;
        const hasUpstream = [first, ...fallbacks].some(value => new URL(value.url).hostname === "huggingface.co");
        throw new ModelDownloadError(hasUpstream && customModelProxy(input.settings) === undefined
          ? "MODEL_DOWNLOAD_PROXY_REQUIRED" : "MODEL_DOWNLOAD_SOURCE_UNAVAILABLE");
      }
      await retainDownloadedAsset(cache, asset, destination);
    }
    received += asset.byteLength;
    input.update({ downloadedBytes: received });
  }
}

export async function installDownloadedModels(input: ModelDownloadOperationInput): Promise<void> {
  await mkdir(input.dataRoot, { recursive: true, mode: 0o700 });
  const cache = await prepareDownloadCache(input.dataRoot, input.pack);
  const root = await mkdtemp(join(input.dataRoot, ".model-download-"));
  try {
    await receiveModels(input, root, cache);
    cancelled(input.signal);
    input.update({ phase: "verifying" });
    const archive = join(root, "models.tar");
    await buildModelPack({ pack: input.pack, modelRoot: join(root, "models"),
      outputPath: archive, packageRoot: input.packageRoot, signal: input.signal });
    cancelled(input.signal);
    input.update({ phase: "installing" });
    await stageModelPack({ dataRoot: input.dataRoot, packageRoot: input.packageRoot,
      modelPackPath: archive, signal: input.signal });
    await rm(cache, { recursive: true, force: true }).catch(() => undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
}
