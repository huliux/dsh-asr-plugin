import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadWorkerAssets } from "../../src/worker/worker-assets.js";

const temporaryDirectories: string[] = [];
const MODEL_ASSET = {
  id: "example-model",
  kind: "model",
  relativePath: "models/example.onnx",
  byteLength: 11,
  sha256: "9cb7487000bc86ac36ce83c4acfabe8878552be99572a6770f65ab1d048a5c48",
};
const NATIVE_ASSET = {
  id: "example-native",
  kind: "native",
  relativePath: "native/darwin-arm64/example.node",
  byteLength: 12,
  sha256: "b0ca94ca54cf33f214f3bf9f31dddf9438ae1a42a93cb493454f741a1e6f024e",
  runtime: {
    platform: process.platform,
    architecture: process.arch,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    napi: Number(process.versions.napi),
  },
};
const UNRELATED_ASSET = {
  id: "unrelated-model",
  kind: "model",
  relativePath: "models/missing.onnx",
  byteLength: 1,
  sha256: "0".repeat(64),
};

async function writeFixture(root: string, relativePath: string, bytes: string): Promise<string> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

async function createWorkerAssetFixture(assets: readonly unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-worker-assets-"));
  temporaryDirectories.push(root);
  const modelRoot = join(root, "data", "assets", "fingerprint");
  const packagedNativeRoot = join(root, "plugin", "dist");
  const modelPath = await writeFixture(modelRoot, "models/example.onnx", "model bytes");
  const nativePath = await writeFixture(
    packagedNativeRoot,
    "native/darwin-arm64/example.node",
    "native bytes",
  );
  const manifestPath = await writeFixture(
    packagedNativeRoot,
    "assets/manifest.json",
    JSON.stringify({ schemaVersion: 2, algorithmRevision: "test-v1", assets }),
  );
  const config = {
    modelRoot,
    packagedNativeRoot,
    manifestPath,
    managedAudioDirectory: join(root, "meetings"),
  };
  return { config, modelPath, nativePath, root };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

describe("Worker runtime assets", () => {
  it("在 READY 前从模型根与包内 native 根独立复验清单", async () => {
    const { config, modelPath, nativePath, root } = await createWorkerAssetFixture([
      MODEL_ASSET,
      NATIVE_ASSET,
    ]);
    const result = await loadWorkerAssets(config, ["example-model", "example-native"]);

    expect(result.paths).toEqual({
      "example-model": modelPath,
      "example-native": nativePath,
    });
    expect(result.engineFingerprint).toMatch(/^[0-9a-f]{64}$/u);

    await rm(modelPath);
    const outsideModel = await writeFixture(root, "outside/model.onnx", "model bytes");
    await symlink(outsideModel, modelPath);
    await expect(loadWorkerAssets(config, ["example-model"])).rejects.toMatchObject({
      code: "ASSET_PATH_INVALID",
      assetId: "example-model",
    });
  });

  it("只复验当前 Worker 声明的资产并拒绝未知 id", async () => {
    const { config, modelPath } = await createWorkerAssetFixture([
      MODEL_ASSET,
      UNRELATED_ASSET,
    ]);

    await expect(loadWorkerAssets(config, ["example-model"])).resolves.toMatchObject({
      paths: { "example-model": modelPath },
    });
    await expect(loadWorkerAssets(config, ["unknown-model"])).rejects.toMatchObject({
      code: "ASSET_MISSING",
      assetId: "unknown-model",
    });
  });
});
