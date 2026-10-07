import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHash } from "node:crypto";
import { writeModelPackArchive } from "../../src/assets/model-pack-archive-writer.js";
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


describe("model pack build cancellation", () => {
  it("rejects an aborted build before producing an archive", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(buildModelPack({ modelRoot: fixture.sourceRoot, packageRoot: fixture.packageRoot,
      outputPath: fixture.outputOne, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(stat(fixture.outputOne)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops hashing after cancellation without publishing an archive", async () => {
    const fixture = await createFixture();
    const model = join(fixture.sourceRoot, "models/example.onnx");
    const bytes = Buffer.alloc(4 * 1_024 * 1_024, 2);
    await writeFile(model, bytes);
    const manifestPath = join(fixture.packageRoot, "dist/assets/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.assets[0].byteLength = bytes.length;
    manifest.assets[0].sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const handle = await open(model, "r");
    const prototype = Object.getPrototypeOf(handle) as typeof handle;
    const originalRead = prototype.read;
    const controller = new AbortController();
    const observe = vi.spyOn(prototype, "read").mockImplementation(async function (
      this: typeof handle, ...args: Parameters<typeof handle.read>
    ) {
      const result = await originalRead.apply(this, args);
      controller.abort();
      return result;
    });
    try {
      await expect(buildModelPack({ modelRoot: fixture.sourceRoot, packageRoot: fixture.packageRoot,
        outputPath: fixture.outputOne, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(observe).toHaveBeenCalledTimes(1);
      await expect(stat(fixture.outputOne)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { observe.mockRestore(); await handle.close(); }
  });

  it("stops archive copying after cancellation and removes the temporary output", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-asr-pack-cancel-"));
    roots.push(root);
    const bytes = Buffer.alloc(4 * 1_024 * 1_024, 1);
    const source = join(root, "model.onnx");
    await writeFile(source, bytes);
    const handle = await open(source, "r");
    const controller = new AbortController();
    const originalRead = handle.read.bind(handle);
    const observe = vi.spyOn(handle, "read").mockImplementation(async (...args: Parameters<typeof handle.read>) => {
      const result = await originalRead(...args);
      controller.abort();
      return result;
    });
    try {
      await expect(writeModelPackArchive(join(root, "pack.tar"), Buffer.from("{}"), [{
        assetId: "model", byteLength: bytes.length, handle, relativePath: "model.onnx",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(observe).toHaveBeenCalledTimes(1);
      expect(await readdir(root)).toEqual(["model.onnx"]);
    } finally { observe.mockRestore(); await handle.close(); }
  });
});
