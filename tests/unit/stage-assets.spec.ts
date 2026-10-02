import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { stageAssets } from "../../src/assets/stage-assets.js";

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

describe("stageAssets", () => {
  it("从调用者显式指定的来源复制并验证资产", async () => {
    const content = Buffer.from("staged asset");
    const fixture = await createFixture({
      schemaVersion: 2,
      algorithmRevision: "test-v1",
      assets: [
        {
          id: "example",
          kind: "model",
          relativePath: "models/example.onnx",
          byteLength: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      ],
    });
    const sourcePath = join(fixture.fixtureRoot, "source.onnx");
    await writeFile(sourcePath, content);

    await expect(
      stageAssets({ ...fixture, sources: { example: sourcePath } }),
    ).resolves.toEqual({
      example: join(fixture.assetRoot, "models", "example.onnx"),
    });
  });

  it("来源校验失败时保留已有正确资产", async () => {
    const expected = Buffer.from("expected");
    const fixture = await createFixture(
      {
        schemaVersion: 2,
        algorithmRevision: "test-v1",
        assets: [
          {
            id: "example",
            kind: "model",
            relativePath: "models/example.onnx",
            byteLength: expected.byteLength,
            sha256: createHash("sha256").update(expected).digest("hex"),
          },
        ],
      },
      { "models/example.onnx": expected },
    );
    const sourcePath = join(fixture.fixtureRoot, "tampered.onnx");
    await writeFile(sourcePath, Buffer.from("tampered"));

    await expect(
      stageAssets({ ...fixture, sources: { example: sourcePath } }),
    ).rejects.toMatchObject({
      code: "ASSET_HASH_MISMATCH",
      assetId: "example",
    });
    await expect(
      readFile(join(fixture.assetRoot, "models", "example.onnx")),
    ).resolves.toEqual(expected);
  });

  it("缺少显式来源时在复制前失败", async () => {
    const fixture = await createFixture({
      schemaVersion: 2,
      algorithmRevision: "test-v1",
      assets: [
        {
          id: "missing-source",
          kind: "model",
          relativePath: "models/example.onnx",
          byteLength: 1,
          sha256: "0".repeat(64),
        },
      ],
    });

    await expect(stageAssets({ ...fixture, sources: {} })).rejects.toMatchObject({
      code: "STAGE_SOURCE_MISSING",
      assetId: "missing-source",
    });
  });
});
