import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  fingerprintAssetManifest,
  verifyAssets,
} from "../../src/assets/verify-assets.js";

const temporaryDirectories: string[] = [];

async function createFixture(
  manifest: unknown,
  files: Record<string, string | Buffer> = {},
): Promise<{ assetRoot: string; fixtureRoot: string; manifestPath: string }> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-asr-assets-"));
  temporaryDirectories.push(fixtureRoot);
  const assetRoot = join(fixtureRoot, "assets");
  const manifestPath = join(fixtureRoot, "manifest.json");
  await mkdir(assetRoot, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(assetRoot, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { assetRoot, fixtureRoot, manifestPath };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("verifyAssets", () => {
  it("以验证过的 manifest 原始字节生成引擎指纹", async () => {
    const manifest = { schemaVersion: 2, algorithmRevision: "test-v1", assets: [] };
    const fixture = await createFixture(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest));

    await expect(fingerprintAssetManifest(fixture.manifestPath)).resolves.toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });

  it("拒绝旧 schema 与混入 runtime manifest 的供应链字段", async () => {
    const oldSchema = await createFixture({
      schemaVersion: 1,
      algorithmRevision: "test-v1",
      assets: [],
    });
    const mixedConcern = await createFixture({
      schemaVersion: 2,
      algorithmRevision: "test-v1",
      assets: [{
        id: "example",
        kind: "model",
        relativePath: "models/example.onnx",
        byteLength: 0,
        sha256: "0".repeat(64),
        source: { mode: "reuse", provenance: "wrong layer" },
      }],
    });

    await expect(fingerprintAssetManifest(oldSchema.manifestPath)).rejects.toMatchObject({
      code: "MANIFEST_INVALID",
    });
    await expect(fingerprintAssetManifest(mixedConcern.manifestPath)).rejects.toMatchObject({
      code: "MANIFEST_INVALID",
      assetId: "example",
    });
  });

  it.each([
    ["空 platform", { platform: "", architecture: "arm64", nodeMajor: 24, napi: 10 }],
    ["空 architecture", { platform: "darwin", architecture: "", nodeMajor: 24, napi: 10 }],
    ["非正 nodeMajor", { platform: "darwin", architecture: "arm64", nodeMajor: 0, napi: 10 }],
    ["非正 napi", { platform: "darwin", architecture: "arm64", nodeMajor: 24, napi: 0 }],
  ])("拒绝 native 资产的%s", async (_caseName, runtime) => {
    const fixture = await createFixture({
      schemaVersion: 2,
      algorithmRevision: "test-v1",
      assets: [{
        id: "example",
        kind: "native",
        relativePath: "native/example.node",
        byteLength: 1,
        sha256: "0".repeat(64),
        runtime,
      }],
    });

    await expect(fingerprintAssetManifest(fixture.manifestPath)).rejects.toMatchObject({
      code: "MANIFEST_INVALID",
      assetId: "example",
    });
  });

  it("返回通过大小与哈希校验的资产绝对路径", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-asr-assets-"));
    temporaryDirectories.push(fixtureRoot);
    const assetRoot = join(fixtureRoot, "assets");
    const manifestPath = join(fixtureRoot, "manifest.json");
    const content = Buffer.from("verified asset");
    await mkdir(join(assetRoot, "native"), { recursive: true });
    await writeFile(join(assetRoot, "native", "example.node"), content);
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        algorithmRevision: "test-v1",
        assets: [
          {
            id: "example",
            kind: "native",
            relativePath: "native/example.node",
            byteLength: content.byteLength,
            sha256: createHash("sha256").update(content).digest("hex"),
            runtime: {
              platform: "darwin",
              architecture: "arm64",
              nodeMajor: 24,
              napi: 10,
            },
          },
        ],
      }),
    );

    await expect(
      verifyAssets({
        assetRoot,
        manifestPath,
        runtime: {
          platform: "darwin",
          architecture: "arm64",
          nodeMajor: 24,
          napi: 10,
        },
      }),
    ).resolves.toEqual({ example: join(assetRoot, "native", "example.node") });
  });

  it("将缺失文件报告为稳定的资产错误", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-asr-assets-"));
    temporaryDirectories.push(fixtureRoot);
    const assetRoot = join(fixtureRoot, "assets");
    const manifestPath = join(fixtureRoot, "manifest.json");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        algorithmRevision: "test-v1",
        assets: [
          {
            id: "missing",
            kind: "model",
            relativePath: "models/missing.onnx",
            byteLength: 1,
            sha256: "0".repeat(64),
          },
        ],
      }),
    );

    await expect(verifyAssets({ assetRoot, manifestPath })).rejects.toMatchObject({
      name: "AssetVerificationError",
      code: "ASSET_MISSING",
      assetId: "missing",
    });
  });

  it("拒绝逃出受管资产根的相对路径", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-asr-assets-"));
    temporaryDirectories.push(fixtureRoot);
    const assetRoot = join(fixtureRoot, "assets");
    const manifestPath = join(fixtureRoot, "manifest.json");
    const content = Buffer.from("outside asset root");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(join(fixtureRoot, "outside.bin"), content);
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        algorithmRevision: "test-v1",
        assets: [
          {
            id: "outside",
            kind: "model",
            relativePath: "../outside.bin",
            byteLength: content.byteLength,
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        ],
      }),
    );

    await expect(verifyAssets({ assetRoot, manifestPath })).rejects.toMatchObject({
      code: "ASSET_PATH_INVALID",
      assetId: "outside",
    });
  });

  it("将损坏的 manifest 报告为稳定错误", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-asr-assets-"));
    temporaryDirectories.push(fixtureRoot);
    const assetRoot = join(fixtureRoot, "assets");
    const manifestPath = join(fixtureRoot, "manifest.json");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(manifestPath, "{not-json");

    await expect(verifyAssets({ assetRoot, manifestPath })).rejects.toMatchObject({
      name: "AssetVerificationError",
      code: "MANIFEST_INVALID",
    });
  });

  it("在访问文件前拒绝不完整的资产记录", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-asr-assets-"));
    temporaryDirectories.push(fixtureRoot);
    const assetRoot = join(fixtureRoot, "assets");
    const manifestPath = join(fixtureRoot, "manifest.json");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        algorithmRevision: "test-v1",
        assets: [{ id: "incomplete" }],
      }),
    );

    await expect(verifyAssets({ assetRoot, manifestPath })).rejects.toMatchObject({
      code: "MANIFEST_INVALID",
      assetId: "incomplete",
    });
  });

  it.each([
    ["architecture", "x64"],
    ["nodeMajor", 23],
    ["napi", 9],
  ] as const)("在加载 native 资产前拒绝不匹配的 %s", async (field, value) => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-asr-assets-"));
    temporaryDirectories.push(fixtureRoot);
    const assetRoot = join(fixtureRoot, "assets");
    const manifestPath = join(fixtureRoot, "manifest.json");
    const content = Buffer.from("native asset");
    await mkdir(join(assetRoot, "native"), { recursive: true });
    await writeFile(join(assetRoot, "native", "example.node"), content);
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        algorithmRevision: "test-v1",
        assets: [
          {
            id: "example",
            kind: "native",
            relativePath: "native/example.node",
            byteLength: content.byteLength,
            sha256: createHash("sha256").update(content).digest("hex"),
            runtime: {
              platform: "darwin",
              architecture: "arm64",
              nodeMajor: 24,
              napi: 10,
            },
          },
        ],
      }),
    );

    await expect(
      verifyAssets({
        assetRoot,
        manifestPath,
        runtime: {
          platform: "darwin",
          architecture: "arm64",
          nodeMajor: 24,
          napi: 10,
          [field]: value,
        },
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_MISMATCH",
      assetId: "example",
    });
  });

  it("拒绝重复的逻辑资产 ID", async () => {
    const content = Buffer.from("duplicate id");
    const record = {
      id: "duplicate",
      kind: "model",
      relativePath: "models/duplicate.onnx",
      byteLength: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    const fixture = await createFixture(
      { schemaVersion: 2, algorithmRevision: "test-v1", assets: [record, record] },
      { "models/duplicate.onnx": content },
    );

    await expect(verifyAssets(fixture)).rejects.toMatchObject({
      code: "MANIFEST_INVALID",
      assetId: "duplicate",
    });
  });

  it("拒绝两个逻辑资产指向同一目标路径", async () => {
    const content = Buffer.from("duplicate path");
    const common = {
      kind: "model",
      relativePath: "models/shared.onnx",
      byteLength: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    const fixture = await createFixture(
      {
        schemaVersion: 2,
        algorithmRevision: "test-v1",
        assets: [
          { ...common, id: "first" },
          { ...common, id: "second" },
        ],
      },
      { "models/shared.onnx": content },
    );

    await expect(verifyAssets(fixture)).rejects.toMatchObject({
      code: "MANIFEST_INVALID",
      assetId: "second",
    });
  });

  it("拒绝大小不匹配的资产", async () => {
    const expected = Buffer.from("expected");
    const fixture = await createFixture(
      {
        schemaVersion: 2,
        algorithmRevision: "test-v1",
        assets: [
          {
            id: "wrong-size",
            kind: "model",
            relativePath: "models/wrong-size.onnx",
            byteLength: expected.byteLength,
            sha256: createHash("sha256").update(expected).digest("hex"),
          },
        ],
      },
      { "models/wrong-size.onnx": Buffer.from("unexpected size") },
    );

    await expect(verifyAssets(fixture)).rejects.toMatchObject({
      code: "ASSET_SIZE_MISMATCH",
      assetId: "wrong-size",
    });
  });

  it("拒绝同等大小但哈希不匹配的资产", async () => {
    const expected = Buffer.from("expected");
    const fixture = await createFixture(
      {
        schemaVersion: 2,
        algorithmRevision: "test-v1",
        assets: [
          {
            id: "wrong-hash",
            kind: "model",
            relativePath: "models/wrong-hash.onnx",
            byteLength: expected.byteLength,
            sha256: createHash("sha256").update(expected).digest("hex"),
          },
        ],
      },
      { "models/wrong-hash.onnx": Buffer.from("tampered") },
    );

    await expect(verifyAssets(fixture)).rejects.toMatchObject({
      code: "ASSET_HASH_MISMATCH",
      assetId: "wrong-hash",
    });
  });
});
