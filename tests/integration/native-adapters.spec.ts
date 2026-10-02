import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyAssets } from "../../src/assets/verify-assets.js";
import { loadFbank } from "../../src/native/fbank.js";
import { loadHCluster } from "../../src/native/hcluster.js";

let fbankPath: string;
let hclusterPath: string;

describe.skipIf(process.env.DSH_RUN_NATIVE_ADAPTERS !== "1")("native adapters", () => {
  beforeAll(async () => {
    const assets = await verifyAssets({ assetRoot: resolve("data/assets"),
      manifestPath: resolve("src/assets/manifest.json") });
    if (assets["fbank-native"] === undefined || assets["hcluster-native"] === undefined) {
      throw new Error("Native assets are missing from the manifest");
    }
    fbankPath = assets["fbank-native"]; hclusterPath = assets["hcluster-native"];
  });

  it("通过 fbank seam 提取有限的 80 维特征", () => {
    const samples = Float32Array.from(
      { length: 16_000 },
      (_, index) => Math.sin((2 * Math.PI * 440 * index) / 16_000) * 0.1,
    );

    const features = loadFbank(fbankPath).extract(samples);

    expect(features.dims[0]).toBeGreaterThan(0);
    expect(features.dims[1]).toBe(80);
    expect(features.data).toHaveLength(features.dims[0] * features.dims[1]);
    expect(features.data.every(Number.isFinite)).toBe(true);
  });

  it("通过 hcluster seam 返回守恒的聚类索引", () => {
    const vector = (value: number, offset: number) =>
      Float32Array.from(
        { length: 256 },
        (_, index) => value + (index === 0 ? offset : 0),
      );
    const embeddings = [
      vector(0, 0),
      vector(0, 0.01),
      vector(10, 0),
      vector(10, 0.01),
    ];

    const clusters = loadHCluster(hclusterPath).cluster(embeddings, { k: 2 });

    expect(clusters).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("在进入 fbank native 前拒绝非有限输入", () => {
    expect(() =>
      loadFbank(fbankPath).extract(new Float32Array([Number.NaN])),
    ).toThrow(expect.objectContaining({ code: "NATIVE_INPUT_INVALID" }));
  });

  it("在进入 hcluster native 前拒绝错误维度", () => {
    expect(() =>
      loadHCluster(hclusterPath).cluster([new Float32Array(255)], { k: 1 }),
    ).toThrow(expect.objectContaining({ code: "NATIVE_INPUT_INVALID" }));
  });

  it("在进入 hcluster native 前拒绝非有限 embedding", () => {
    const embedding = new Float32Array(256);
    embedding[10] = Number.POSITIVE_INFINITY;

    expect(() =>
      loadHCluster(hclusterPath).cluster([embedding], { k: 1 }),
    ).toThrow(expect.objectContaining({ code: "NATIVE_INPUT_INVALID" }));
  });

  it("处理单个 embedding 且拒绝越界 k", () => {
    const adapter = loadHCluster(hclusterPath);
    const embedding = new Float32Array(256);

    expect(adapter.cluster([embedding], { k: 1 })).toEqual([[0]]);
    expect(() => adapter.cluster([embedding], { k: 2 })).toThrow(
      expect.objectContaining({ code: "NATIVE_INPUT_INVALID" }),
    );
  });
});
