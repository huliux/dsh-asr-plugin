import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareP1aRuntimeAssetFixture } from "../helpers/p1a-runtime-assets.js";

const roots: string[] = [];
const MODEL_SHA256 = "9372c470eeadd5ecd9c3c74c2b3cb633f8e2f2fad799250a0f70d652b6b825e4";
const MODEL_SET_FINGERPRINT =
  "e3aed1b93461a627c3d9f07a6d7db3d4303a1b4b9a6eb874950e3d9100b3beb2";
const NATIVE_BYTES = "native";
const FIXTURE_MANIFEST = {
  schemaVersion: 2,
  algorithmRevision: "fixture-v1",
  assets: [
    {
      id: "example-config",
      kind: "config",
      relativePath: "models/asr/config.yaml",
      byteLength: 5,
      sha256: MODEL_SHA256,
    },
    {
      id: "example-native",
      kind: "native",
      relativePath: "native/darwin-arm64/example.node",
      byteLength: NATIVE_BYTES.length,
      sha256: createHash("sha256").update(NATIVE_BYTES).digest("hex"),
      runtime: {
        platform: process.platform,
        architecture: process.arch,
        nodeMajor: Number(process.versions.node.split(".")[0]),
        napi: Number(process.versions.napi),
      },
    },
  ],
};

async function writeFixtureFile(root: string, relativePath: string, bytes: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function createFixture(): Promise<{
  dataRoot: string;
  legacyAssetRoot: string;
  manifestPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-p1a-assets-fixture-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  const legacyAssetRoot = join(root, "legacy-assets");
  const manifestPath = join(root, "dist", "assets", "manifest.json");
  await writeFixtureFile(legacyAssetRoot, "models/asr/config.yaml", "model");
  await writeFixtureFile(root, "dist/assets/manifest.json", JSON.stringify(FIXTURE_MANIFEST));
  return { dataRoot, legacyAssetRoot, manifestPath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P1a RuntimeAssets fixture", () => {
  it("把已验证模型硬链接到内容寻址目录且不把 legacy native 混入模型根", async () => {
    const { dataRoot, legacyAssetRoot, manifestPath } = await createFixture();
    const result = await prepareP1aRuntimeAssetFixture({
      dataRoot,
      legacyAssetRoot,
      manifestPath,
    });
    const source = join(legacyAssetRoot, "models/asr/config.yaml");
    const target = join(dataRoot, "assets", MODEL_SET_FINGERPRINT, "models/asr/config.yaml");
    const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target)]);

    expect(result).toEqual({
      modelRoot: join(dataRoot, "assets", MODEL_SET_FINGERPRINT),
      modelSetFingerprint: MODEL_SET_FINGERPRINT,
    });
    expect(await readFile(target, "utf8")).toBe("model");
    expect(targetStat.ino).toBe(sourceStat.ino);
    await expect(stat(join(
      dataRoot,
      "assets",
      MODEL_SET_FINGERPRINT,
      "native/darwin-arm64/example.node",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
