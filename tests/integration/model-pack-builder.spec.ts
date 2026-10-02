import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { stageModelPack } from "../../src/assets/runtime-assets.js";
import { buildModelPack } from "../../src/maintenance/model-pack-builder.js";

const MODEL_BYTES = Buffer.from("model bytes");
const MODEL_SHA256 = "9cb7487000bc86ac36ce83c4acfabe8878552be99572a6770f65ab1d048a5c48";
const MODEL_SET_FINGERPRINT =
  "ddc9cb78463f9cbd00a44d5feb30c5051fe93493fee52eddfc721c5684ecad17";
const roots: string[] = [];

async function writeFixtureFile(root: string, path: string, bytes: string | Buffer): Promise<void> {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

async function createFixture(): Promise<{
  dataRoot: string;
  outputOne: string;
  outputTwo: string;
  packageRoot: string;
  sourceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-pack-builder-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  const sourceRoot = join(root, "source");
  await writeFixtureFile(packageRoot, "dist/assets/manifest.json", JSON.stringify({
    schemaVersion: 2,
    algorithmRevision: "test-v1",
    assets: [{
      id: "example-model",
      kind: "model",
      relativePath: "models/example.onnx",
      byteLength: MODEL_BYTES.byteLength,
      sha256: MODEL_SHA256,
    }],
  }));
  await writeFixtureFile(packageRoot, "LICENSE", "license\n");
  await writeFixtureFile(packageRoot, "THIRD_PARTY_NOTICES.md", "notices\n");
  await writeFixtureFile(packageRoot, "third_party/licenses/upstream.txt", "upstream\n");
  await writeFixtureFile(sourceRoot, "models/example.onnx", MODEL_BYTES);
  return {
    dataRoot: join(root, "data"),
    outputOne: join(root, "pack-one.tar"),
    outputTwo: join(root, "pack-two.tar"),
    packageRoot,
    sourceRoot,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("model pack builder 可复现交付", () => {
  it("生成可被正式 staging 接受且逐字节可复现的严格 USTAR", async () => {
    const fixture = await createFixture();
    const first = await buildModelPack({
      modelRoot: fixture.sourceRoot,
      outputPath: fixture.outputOne,
      packageRoot: fixture.packageRoot,
    });
    const second = await buildModelPack({
      modelRoot: fixture.sourceRoot,
      outputPath: fixture.outputTwo,
      packageRoot: fixture.packageRoot,
    });

    expect(first).toEqual({
      archiveByteLength: first.archiveByteLength,
      archiveSha256: first.archiveSha256,
      assetCount: 1,
      modelBytes: MODEL_BYTES.byteLength,
      modelSetFingerprint: MODEL_SET_FINGERPRINT,
    });
    expect(second).toEqual(first);
    await expect(readFile(fixture.outputTwo)).resolves.toEqual(await readFile(fixture.outputOne));
    await expect(stageModelPack({
      dataRoot: fixture.dataRoot,
      modelPackPath: fixture.outputOne,
      packageRoot: fixture.packageRoot,
    })).resolves.toEqual({
      installed: true,
      modelSetFingerprint: MODEL_SET_FINGERPRINT,
    });
    await expect(readFile(join(
      fixture.dataRoot,
      "assets",
      MODEL_SET_FINGERPRINT,
      "models/example.onnx",
    ))).resolves.toEqual(MODEL_BYTES);
  });
});

describe("model pack builder 输入边界", () => {
  it("拒绝覆盖既有归档，也不为损坏模型留下输出", async () => {
    const fixture = await createFixture();
    await buildModelPack({
      modelRoot: fixture.sourceRoot,
      outputPath: fixture.outputOne,
      packageRoot: fixture.packageRoot,
    });
    await expect(buildModelPack({
      modelRoot: fixture.sourceRoot,
      outputPath: fixture.outputOne,
      packageRoot: fixture.packageRoot,
    })).rejects.toMatchObject({ code: "MODEL_PACK_OUTPUT_EXISTS" });

    await writeFile(join(fixture.sourceRoot, "models/example.onnx"), "wrong bytes");
    await expect(buildModelPack({
      modelRoot: fixture.sourceRoot,
      outputPath: fixture.outputTwo,
      packageRoot: fixture.packageRoot,
    })).rejects.toMatchObject({ code: "ASSET_HASH_MISMATCH" });
    await expect(stat(fixture.outputTwo)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("拒绝模型和法务材料目录经中间 symlink 逃出输入根", async () => {
    const modelFixture = await createFixture();
    const outsideModels = join(modelFixture.dataRoot, "outside-models");
    await writeFixtureFile(outsideModels, "example.onnx", MODEL_BYTES);
    await rm(join(modelFixture.sourceRoot, "models"), { recursive: true });
    await symlink(outsideModels, join(modelFixture.sourceRoot, "models"), "dir");
    await expect(buildModelPack({
      modelRoot: modelFixture.sourceRoot,
      outputPath: modelFixture.outputOne,
      packageRoot: modelFixture.packageRoot,
    })).rejects.toMatchObject({ code: "ASSET_PATH_INVALID" });

    const legalFixture = await createFixture();
    const outsideLegal = join(legalFixture.dataRoot, "outside-legal");
    await writeFixtureFile(outsideLegal, "upstream.txt", "upstream\n");
    await rm(join(legalFixture.packageRoot, "third_party"), { recursive: true });
    await symlink(outsideLegal, join(legalFixture.packageRoot, "third_party"), "dir");
    await expect(buildModelPack({
      modelRoot: legalFixture.sourceRoot,
      outputPath: legalFixture.outputOne,
      packageRoot: legalFixture.packageRoot,
    })).rejects.toMatchObject({ code: "MODEL_PACK_BUILD_INVALID" });
  });
});
