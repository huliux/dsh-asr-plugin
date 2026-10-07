import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readSupplyChainManifest } from "../../src/assets/supply-chain.js";
import { readAssetManifest, resolveAssetPath } from "../../src/assets/verify-assets.js";
import { loadFbank } from "../../src/native/fbank.js";

const LEGACY_BYTE_LENGTH = 156_160;
const LEGACY_SHA256 = "3f0b35fb52cd6f8e7d2a00e37e002a2be606750a5ae5b8d7836931de9319c567";
const REBUILT_BYTE_LENGTH = 141_448;
const REBUILT_SHA256 = "62c2b1077eefaa9ada40a9fdc4b8e6a0bfd248084336be130310dab7f57c4438";

interface FbankGolden {
  readonly data: number[];
  readonly dims: [number, 80];
  readonly input: {
    readonly generator: "deterministic-sine-v1";
    readonly sampleCount: number;
    readonly sampleRate: 16_000;
  };
  readonly schemaVersion: 1;
  readonly sourceBinary: {
    readonly byteLength: number;
    readonly sha256: string;
  };
}

const suite = describe.skipIf(process.env.DSH_RUN_FBANK_REBUILD !== "1");

function createSamples(sampleCount: number): Float32Array {
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / 16_000;
    const perturbation = ((index * 17) % 101 - 50) / 5_000;
    samples[index] = 0.35 * Math.sin(2 * Math.PI * 220 * time)
      + 0.17 * Math.cos(2 * Math.PI * 710 * time)
      + perturbation;
  }
  return samples;
}

async function readGolden(): Promise<FbankGolden> {
  const text = await readFile(resolve("tests/fixtures/native/fbank/golden-v1.json"), "utf8");
  const value: unknown = JSON.parse(text);
  if (!isGolden(value)) throw new Error("Invalid fbank migration golden");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGolden(value: unknown): value is FbankGolden {
  if (!isRecord(value) || !isRecord(value.input) || !isRecord(value.sourceBinary)) {
    return false;
  }
  const dims = value.dims;
  const data = value.data;
  return value.schemaVersion === 1
    && value.input.generator === "deterministic-sine-v1"
    && value.input.sampleRate === 16_000
    && value.input.sampleCount === 16_000
    && value.sourceBinary.byteLength === LEGACY_BYTE_LENGTH
    && value.sourceBinary.sha256 === LEGACY_SHA256
    && Array.isArray(dims)
    && dims.length === 2
    && Number.isSafeInteger(dims[0])
    && Number(dims[0]) > 0
    && dims[1] === 80
    && Array.isArray(data)
    && data.length === Number(dims[0]) * 80
    && data.every((item) => typeof item === "number" && Number.isFinite(item));
}

suite("可重建 fbank native", () => {
  it("在现有 JS seam 上保持旧二进制的特征数值", async () => {
    const golden = await readGolden();
    const fbank = loadFbank(resolve("native/fbank/build/Release/fbank.node"));

    const actual = fbank.extract(createSamples(golden.input.sampleCount));
    const repeated = fbank.extract(createSamples(golden.input.sampleCount));

    expect(actual.dims).toEqual(golden.dims);
    expect(actual.data).toHaveLength(golden.data.length);
    expect(repeated).toEqual(actual);
    let maxAbsoluteDifference = 0;
    for (let index = 0; index < actual.data.length; index += 1) {
      maxAbsoluteDifference = Math.max(
        maxAbsoluteDifference,
        Math.abs(actual.data[index]! - golden.data[index]!),
      );
    }
    expect(maxAbsoluteDifference).toBeLessThanOrEqual(2e-6);
  });

  it("产品资产与 manifest 均使用从源码重建的公开候选", async () => {
    const manifestPath = resolve("src/assets/manifest.json");
    const manifest = await readAssetManifest(manifestPath);
    const supplyChain = await readSupplyChainManifest({
      runtimeManifestPath: manifestPath,
      supplyChainPath: resolve("src/assets/supply-chain.json"),
    });
    const asset = manifest.assets.find((item) => item.id === "fbank-native");
    const supply = supplyChain.assets.find((item) => item.id === "fbank-native");
    expect(asset).toBeDefined();
    expect(supply).toBeDefined();
    if (asset === undefined || supply === undefined) {
      throw new Error("fbank-native is missing from asset manifests");
    }

    const build = await readFile(resolve("native/fbank/build/Release/fbank.node"));
    const staged = await readFile(resolveAssetPath(resolve("dist"), asset));
    expect({
      byteLength: build.byteLength,
      sha256: createHash("sha256").update(build).digest("hex"),
    }).toEqual({ byteLength: REBUILT_BYTE_LENGTH, sha256: REBUILT_SHA256 });
    expect({
      byteLength: staged.byteLength,
      sha256: createHash("sha256").update(staged).digest("hex"),
    }).toEqual({ byteLength: REBUILT_BYTE_LENGTH, sha256: REBUILT_SHA256 });
    expect({ byteLength: asset.byteLength, sha256: asset.sha256 }).toEqual({
      byteLength: REBUILT_BYTE_LENGTH,
      sha256: REBUILT_SHA256,
    });
    expect(manifest.algorithmRevision).toBe("p1c-recording-v4-base-segmentation");
    expect(supply).toMatchObject({
      sourceMode: "rebuild",
      license: "Apache-2.0 AND MIT AND LicenseRef-Ooura-FFT",
      distribution: "public",
    });
    expect(staged.equals(build)).toBe(true);
  });
});
