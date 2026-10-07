import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { modelDownloadSources } from "../../src/assets/model-download-sources.js";

import {
  readSupplyChainManifest,
  renderThirdPartyNotices,
} from "../../src/assets/supply-chain.js";

const temporaryDirectories: string[] = [];

const runtimeAsset = {
  id: "example-model",
  kind: "model",
  relativePath: "models/example.onnx",
  byteLength: 1,
  sha256: "a".repeat(64),
};

const supplyAsset = {
  id: runtimeAsset.id,
  sourceMode: "reuse",
  canonicalRepository: "https://example.com/models/example",
  revision: "b".repeat(40),
  sourcePath: "model.onnx",
  license: "MIT",
  attribution: "Example model authors",
  distribution: "public",
  licenseFiles: ["LICENSE"],
  transports: [{ kind: "canonical", url: "https://example.com/model.onnx" }],
};

const onnxRuntime = {
  id: "onnxruntime-node",
  sourceMode: "reuse",
  canonicalRepository: "https://github.com/microsoft/onnxruntime",
  revision: "c".repeat(40),
  sourcePath: "js/node",
  license: "MIT",
  attribution: "Microsoft Corporation",
  distribution: "public",
  licenseFiles: ["third_party/onnxruntime/LICENSE"],
  transports: [{
    kind: "npm",
    url: "https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.19.2.tgz",
  }],
  packageName: "onnxruntime-node",
  version: "1.19.2",
  integrity: `sha512-${"A".repeat(86)}==`,
  runtime: {
    platform: "darwin",
    architecture: "arm64",
    nodeMajor: 24,
    addonNapi: 3,
    verifiedNapi: 10,
  },
  artifacts: [{ path: "bin/napi-v3/darwin/arm64/onnxruntime_binding.node", byteLength: 1,
    sha256: "d".repeat(64) }],
  noticeFiles: [{
    path: "LICENSE",
    deliveryPath: "third_party/onnxruntime/LICENSE",
    byteLength: 1,
    sha256: "e".repeat(64),
  }],
};

async function createFixture(supplyChain: unknown = {
  schemaVersion: 1,
  assets: [supplyAsset],
  dependencies: [onnxRuntime],
}): Promise<{ runtimeManifestPath: string; supplyChainPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-supply-chain-"));
  temporaryDirectories.push(root);
  const runtimeManifestPath = join(root, "manifest.json");
  const supplyChainPath = join(root, "supply-chain.json");
  await writeFile(runtimeManifestPath, JSON.stringify({
    schemaVersion: 2,
    algorithmRevision: "test-v1",
    assets: [runtimeAsset],
  }));
  await writeFile(supplyChainPath, JSON.stringify(supplyChain));
  return { runtimeManifestPath, supplyChainPath };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

describe("readSupplyChainManifest", () => {
  it("starts VAD at the mirror and uses a custom proxy only after upstream HF", async () => {
    const manifest = await readSupplyChainManifest({ runtimeManifestPath: resolve("src/assets/manifest.json"),
      supplyChainPath: resolve("src/assets/supply-chain.json") });
    const source = manifest.assets.find(asset => asset.id === "vad-model");
    if (source === undefined) throw new Error("VAD source missing");
    const sources = modelDownloadSources(source, { route: "default", proxyKind: "http", proxyUrl: "http://localhost:7890" });
    expect(sources.map(value => ({ host: new URL(value.url).hostname, proxy: value.proxyUrl }))).toEqual([
      { host: "hf-mirror.com", proxy: undefined }, { host: "huggingface.co", proxy: undefined },
      { host: "huggingface.co", proxy: "http://localhost:7890/" },
    ]);
    expect(modelDownloadSources(source, { route: "direct", proxyUrl: "http://localhost:7890" })).toEqual(sources.slice(0, 2));
  });
  it("does not add a proxy fallback to ModelScope-only weights", async () => {
    const manifest = await readSupplyChainManifest({ runtimeManifestPath: resolve("src/assets/manifest.json"),
      supplyChainPath: resolve("src/assets/supply-chain.json") });
    for (const id of ["asr-model", "punc-model"]) {
      const source = manifest.assets.find(asset => asset.id === id);
      if (source === undefined) throw new Error("Weight source missing");
      const sources = modelDownloadSources(source, { route: "default", proxyKind: "http", proxyUrl: "http://localhost:7890" });
      expect(sources).toHaveLength(1);
      expect(new URL(sources[0]!.url).hostname).toBe("modelscope.cn");
      expect(sources[0]!.proxyUrl).toBeUndefined();
    }
  });
  it("prefers the verified domestic speaker copy while preserving its original license", async () => {
    const manifest = await readSupplyChainManifest({
      runtimeManifestPath: resolve("src/assets/manifest.json"),
      supplyChainPath: resolve("src/assets/supply-chain.json"),
    });
    const source = manifest.assets.find(({ id }) => id === "speaker-embedding-model");
    if (source === undefined) throw new Error("Speaker source missing");
    expect(source.license).toBe("CC-BY-4.0");
    expect(source.canonicalRepository).toBe("https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM");
    expect(modelDownloadSources(source, { route: "default" }))
      .toEqual([
        { url: "https://modelscope.cn/api/v1/models/manyeyes/speaker_recognition_task_models_onnx_collection/repo?Revision=62cc6fed28b3413dd6351898a6fc5a5f616f5d8e&FilePath=wespeaker_en_voxceleb_resnet34_LM.onnx" },
        { url: "https://hf-mirror.com/Wespeaker/wespeaker-voxceleb-resnet34-LM/resolve/f0c48c298fd835726c27956a5d617bad7115627e/voxceleb_resnet34_LM.onnx" },
        { url: "https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM/resolve/f0c48c298fd835726c27956a5d617bad7115627e/voxceleb_resnet34_LM.onnx" },
      ]);
  });

  it("falls back to the pinned mirror before upstream HF support files", async () => {
    const manifest = await readSupplyChainManifest({
      runtimeManifestPath: resolve("src/assets/manifest.json"),
      supplyChainPath: resolve("src/assets/supply-chain.json"),
    });
    const copies = [
      ["asr-config", "https://huggingface.co/Haujet/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-onnx/resolve/72b5a81d56d23bb0480b28b3181bfab5be712c0d/config.yaml"],
      ["asr-cmvn", "https://huggingface.co/Haujet/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-onnx/resolve/72b5a81d56d23bb0480b28b3181bfab5be712c0d/am.mvn"],
      ["asr-tokens", "https://huggingface.co/Haujet/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-onnx/resolve/72b5a81d56d23bb0480b28b3181bfab5be712c0d/tokens.json"],
      ["punc-config", "https://huggingface.co/lucasjin/punc_ct-transformer_zh-cn-common-vocab272727-pytorch/resolve/ac099bf061266095ed76777c3c12dda39393630a/config.yaml"],
      ["punc-tokens", "https://huggingface.co/lucasjin/punc_ct-transformer_zh-cn-common-vocab272727-pytorch/resolve/ac099bf061266095ed76777c3c12dda39393630a/tokens.json"],
    ];
    for (const [id, url] of copies) {
      const source = manifest.assets.find((asset) => asset.id === id);
      if (source === undefined || url === undefined) throw new Error("Model source missing");
      expect(source.license).toBe("Apache-2.0");
      expect(new URL(source.canonicalRepository).hostname).toBe("modelscope.cn");
      const sources = modelDownloadSources(source, { route: "default" });
      expect(new URL(sources[0]!.url).hostname).toBe("modelscope.cn");
      expect(sources.slice(1)).toEqual([
        { url: url.replace("huggingface.co", "hf-mirror.com") }, { url },
      ]);
    }
  });

  it("固化当前 11 个 runtime 资产与 ORT 的真实供应链闭包", async () => {
    const manifest = await readSupplyChainManifest({
      runtimeManifestPath: resolve("src/assets/manifest.json"),
      supplyChainPath: resolve("src/assets/supply-chain.json"),
    });

    expect(manifest.assets).toHaveLength(11);
    expect(manifest.dependencies).toEqual([
      expect.objectContaining({
        id: "onnxruntime-node",
        version: "1.19.2",
        integrity: "sha512-9eHMP/HKbbeUcqte1JYzaaRC8JPn7ojWeCeoyShO86TOR97OCyIyAIOGX3V95ErjslVhJRXY8Em/caIUc0hm1Q==",
      }),
    ]);
    const dependency = manifest.dependencies[0];
    await expect(readFile(resolve("package.json"), "utf8")).resolves.toContain(
      `"onnxruntime-node": "${dependency.version}"`,
    );
    await expect(readFile(resolve("pnpm-lock.yaml"), "utf8")).resolves.toContain(
      `onnxruntime-node@${dependency.version}:\n    resolution: {integrity: ${dependency.integrity}}`,
    );
    for (const source of [...manifest.assets, dependency]) {
      for (const licensePath of source.licenseFiles) {
        await expect(readFile(resolve(licensePath), "utf8")).resolves.not.toHaveLength(0);
      }
    }
    for (const noticeFile of dependency.noticeFiles) {
      const bytes = await readFile(resolve(noticeFile.deliveryPath));
      expect(bytes.byteLength).toBe(noticeFile.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(noticeFile.sha256);
    }
  });

  it("从同一清单生成不混淆传输镜像与来源的发行声明", async () => {
    const manifest = await readSupplyChainManifest({
      runtimeManifestPath: resolve("src/assets/manifest.json"),
      supplyChainPath: resolve("src/assets/supply-chain.json"),
    });

    const notice = renderThirdPartyNotices(manifest);

    expect(notice).toContain("asr-config, asr-cmvn, asr-model, asr-tokens");
    expect(notice).toContain("punc-config, punc-model, punc-tokens");
    expect(notice).toContain("fbank-native");
    expect(manifest.assets.filter((asset) => asset.sourceMode === "rebuild"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "hcluster-native", distribution: "public" }),
      ]));
    expect(notice).not.toContain("closed-pilot-only");
    expect(notice).toContain(manifest.dependencies[0].integrity);
    expect(notice).toContain("WeSpeaker: A research and production oriented");
    expect(notice).toContain("Controllable Time-Delay Transformer");
    expect(notice).toContain("third_party/onnxruntime/ThirdPartyNotices.txt");
    expect(notice).toContain("Bitbook recording capture");
    expect(notice).not.toContain("hf-mirror.com");
    await expect(readFile(resolve("THIRD_PARTY_NOTICES.md"), "utf8")).resolves.toBe(notice);
  });

  it("读取固定来源并验证与 runtime asset id 的完整闭包", async () => {
    const paths = await createFixture();

    await expect(readSupplyChainManifest(paths)).resolves.toMatchObject({
      schemaVersion: 1,
      assets: [{ id: "example-model", revision: "b".repeat(40) }],
      dependencies: [{ id: "onnxruntime-node", version: "1.19.2" }],
    });
  });

  it("accepts publicly distributed native code rebuilt from disclosed vendored source", async () => {
    const paths = await createFixture({
      schemaVersion: 1,
      assets: [{ ...supplyAsset, sourceMode: "rebuild",
        transports: [{ kind: "vendored-source" }],
        buildTarget: { platform: "darwin", architecture: "arm64", napi: 10 } }],
      dependencies: [onnxRuntime],
    });

    await expect(readSupplyChainManifest(paths)).resolves.toMatchObject({
      assets: [{ id: "example-model", distribution: "public", sourceMode: "rebuild" }],
    });
  });

  it.each([
    ["缺少 canonical source", { ...supplyAsset, canonicalRepository: "" }],
    ["使用浮动 revision", { ...supplyAsset, revision: "main" }],
    ["缺少许可证", { ...supplyAsset, license: "" }],
    ["缺少 attribution", { ...supplyAsset, attribution: "" }],
    ["缺少许可证材料", { ...supplyAsset, licenseFiles: [] }],
    ["缺少传输端", { ...supplyAsset, transports: [] }],
  ])("拒绝%s", async (_caseName, invalidAsset) => {
    const paths = await createFixture({
      schemaVersion: 1,
      assets: [invalidAsset],
      dependencies: [onnxRuntime],
    });

    await expect(readSupplyChainManifest(paths)).rejects.toMatchObject({
      name: "SupplyChainError",
      code: "SUPPLY_CHAIN_INVALID",
      entryId: "example-model",
    });
  });

  it("拒绝重复、缺失或多余的 runtime asset id", async () => {
    const duplicate = await createFixture({
      schemaVersion: 1,
      assets: [supplyAsset, supplyAsset],
      dependencies: [onnxRuntime],
    });
    const incomplete = await createFixture({
      schemaVersion: 1,
      assets: [],
      dependencies: [onnxRuntime],
    });
    const extra = await createFixture({
      schemaVersion: 1,
      assets: [supplyAsset, { ...supplyAsset, id: "extra-model" }],
      dependencies: [onnxRuntime],
    });

    await expect(readSupplyChainManifest(duplicate)).rejects.toMatchObject({
      code: "SUPPLY_CHAIN_INVALID",
    });
    await expect(readSupplyChainManifest(incomplete)).rejects.toMatchObject({
      code: "SUPPLY_CHAIN_INVALID",
      entryId: "example-model",
    });
    await expect(readSupplyChainManifest(extra)).rejects.toMatchObject({
      code: "SUPPLY_CHAIN_INVALID",
    });
  });

  it("要求唯一且精确固定的 onnxruntime-node 依赖", async () => {
    const missing = await createFixture({
      schemaVersion: 1,
      assets: [supplyAsset],
      dependencies: [],
    });
    const floating = await createFixture({
      schemaVersion: 1,
      assets: [supplyAsset],
      dependencies: [{ ...onnxRuntime, version: "^1.19.2" }],
    });

    await expect(readSupplyChainManifest(missing)).rejects.toMatchObject({
      code: "SUPPLY_CHAIN_INVALID",
    });
    await expect(readSupplyChainManifest(floating)).rejects.toMatchObject({
      code: "SUPPLY_CHAIN_INVALID",
      entryId: "onnxruntime-node",
    });
  });

  it.each([
    ["空 platform", { ...onnxRuntime, runtime: { ...onnxRuntime.runtime, platform: "" } }],
    ["空 architecture", {
      ...onnxRuntime,
      runtime: { ...onnxRuntime.runtime, architecture: "" },
    }],
    ["非正 Node major", {
      ...onnxRuntime,
      runtime: { ...onnxRuntime.runtime, nodeMajor: 0 },
    }],
    ["非正 addon N-API", {
      ...onnxRuntime,
      runtime: { ...onnxRuntime.runtime, addonNapi: 0 },
    }],
    ["非正 verified N-API", {
      ...onnxRuntime,
      runtime: { ...onnxRuntime.runtime, verifiedNapi: 0 },
    }],
    ["截断的 SHA-512 integrity", {
      ...onnxRuntime,
      integrity: `sha512-${"A".repeat(20)}==`,
    }],
  ])("拒绝 ORT 依赖的%s", async (_caseName, invalidDependency) => {
    const paths = await createFixture({
      schemaVersion: 1,
      assets: [supplyAsset],
      dependencies: [invalidDependency],
    });

    await expect(readSupplyChainManifest(paths)).rejects.toMatchObject({
      code: "SUPPLY_CHAIN_INVALID",
      entryId: "onnxruntime-node",
    });
  });

  it.each([
    ["空 platform", { platform: "", architecture: "arm64", napi: 8 }],
    ["空 architecture", { platform: "darwin", architecture: "", napi: 8 }],
    ["非正 N-API", { platform: "darwin", architecture: "arm64", napi: 0 }],
  ])("拒绝 native 构建目标的%s", async (_caseName, buildTarget) => {
    const paths = await createFixture({
      schemaVersion: 1,
      assets: [{ ...supplyAsset, buildTarget }],
      dependencies: [onnxRuntime],
    });

    await expect(readSupplyChainManifest(paths)).rejects.toMatchObject({
      code: "SUPPLY_CHAIN_INVALID",
      entryId: "example-model",
    });
  });

  it("只允许未知许可证留在封闭外测资产中", async () => {
    const publicUnknown = await createFixture({
      schemaVersion: 1,
      assets: [{ ...supplyAsset, license: "NOASSERTION" }],
      dependencies: [onnxRuntime],
    });
    const closedUnknown = await createFixture({
      schemaVersion: 1,
      assets: [{
        ...supplyAsset,
        license: "NOASSERTION",
        distribution: "closed-pilot-only",
        transports: [{ kind: "user-authorized-staging" }],
      }],
      dependencies: [onnxRuntime],
    });

    await expect(readSupplyChainManifest(publicUnknown)).rejects.toMatchObject({
      code: "SUPPLY_CHAIN_INVALID",
      entryId: "example-model",
    });
    await expect(readSupplyChainManifest(closedUnknown)).resolves.toMatchObject({
      assets: [{ license: "NOASSERTION", distribution: "closed-pilot-only" }],
    });
  });

  it("禁止公开资产使用用户授权暂存传输", async () => {
    const paths = await createFixture({
      schemaVersion: 1,
      assets: [{ ...supplyAsset, transports: [{ kind: "user-authorized-staging" }] }],
      dependencies: [onnxRuntime],
    });

    await expect(readSupplyChainManifest(paths)).rejects.toMatchObject({
      code: "SUPPLY_CHAIN_INVALID",
      entryId: "example-model",
    });
  });
});
