import {
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveRuntimeAssets,
  stageModelPack,
} from "../../src/assets/runtime-assets.js";
import {
  cleanupRuntimeAssetsFixtures,
  configAsset,
  createModelPackFixture,
  MODEL_BYTES,
  MODEL_SET_FINGERPRINT,
  modelAsset,
  nativeAsset,
  TWO_ASSET_FINGERPRINT,
  writeFixtureFile,
} from "../helpers/runtime-assets-fixture.js";

afterEach(cleanupRuntimeAssetsFixtures);

describe("RuntimeAssets staging 基本流程", () => {
  it("原子安装模型归档并从内容寻址目录解析运行根", async () => {
    const fixture = await createModelPackFixture();

    await expect(stageModelPack(fixture)).resolves.toEqual({
      installed: true,
      modelSetFingerprint: MODEL_SET_FINGERPRINT,
    });
    const resolved = await resolveRuntimeAssets(fixture);

    expect(resolved).toMatchObject({
      engineFingerprint: "faf1c5fcc5a5e1ff18f5b647ab1ef07e11dadb3322d670f0486228e8f22624c3",
      modelSetFingerprint: MODEL_SET_FINGERPRINT,
      modelRoot: join(fixture.dataRoot, "assets", MODEL_SET_FINGERPRINT),
      packagedNativeRoot: join(fixture.packageRoot, "dist"),
    });
    await expect(readFile(join(resolved.modelRoot, modelAsset.relativePath))).resolves.toEqual(
      MODEL_BYTES,
    );
  });

  it("重复 staging 仍验证归档且损坏输入不污染已安装模型", async () => {
    const fixture = await createModelPackFixture();
    await stageModelPack(fixture);
    const installedModel = join(
      fixture.dataRoot,
      "assets",
      MODEL_SET_FINGERPRINT,
      modelAsset.relativePath,
    );
    const archive = await readFile(fixture.modelPackPath);
    await writeFile(fixture.modelPackPath, archive.subarray(0, 700));

    await expect(stageModelPack(fixture)).rejects.toMatchObject({
      code: "MODEL_PACK_INVALID",
    });
    await expect(readFile(installedModel)).resolves.toEqual(MODEL_BYTES);
  });
});

describe("RuntimeAssets staging 路径边界", () => {
  it("拒绝把模型存储根经 symlink 重定向到数据根外", async () => {
    const fixture = await createModelPackFixture();
    const outside = join(dirname(fixture.dataRoot), "outside-assets");
    await mkdir(fixture.dataRoot, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(fixture.dataRoot, "assets"), "dir");

    await expect(stageModelPack(fixture)).rejects.toMatchObject({
      code: "MODEL_NOT_READY",
    });
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("拒绝把 staging 租约文件经 symlink 重定向到数据根外", async () => {
    const fixture = await createModelPackFixture();
    const outside = join(dirname(fixture.dataRoot), "outside-stage-lease.sqlite3");
    await writeFile(outside, "untouched");
    await mkdir(fixture.dataRoot, { recursive: true });
    await symlink(outside, join(fixture.dataRoot, "asset-stage-lease.sqlite3"), "file");

    await expect(stageModelPack(fixture)).rejects.toMatchObject({
      code: "MODEL_NOT_READY",
    });
    await expect(readFile(outside, "utf8")).resolves.toBe("untouched");
  });

  it("拒绝通过模型目录中的中间 symlink 读取根外字节", async () => {
    const fixture = await createModelPackFixture();
    await stageModelPack(fixture);
    const modelRoot = join(fixture.dataRoot, "assets", MODEL_SET_FINGERPRINT);
    const outside = join(dirname(fixture.dataRoot), "outside-models");
    await writeFixtureFile(outside, "example.onnx", MODEL_BYTES);
    await rm(join(modelRoot, "models"), { recursive: true });
    await symlink(outside, join(modelRoot, "models"), "dir");

    await expect(resolveRuntimeAssets(fixture)).rejects.toMatchObject({
      code: "ASSET_PATH_INVALID",
      assetId: modelAsset.id,
    });
  });
});

describe("RuntimeAssets staging native 与并发边界", () => {
  it("拒绝通过包内 native 中间 symlink 读取包根外字节", async () => {
    const fixture = await createModelPackFixture({
      runtimeAssets: [modelAsset, nativeAsset],
      packAssets: [modelAsset],
    });
    await stageModelPack(fixture);
    const outside = join(dirname(fixture.packageRoot), "outside-native");
    await writeFixtureFile(outside, "darwin-arm64/example.node", "native bytes");
    await mkdir(join(fixture.packageRoot, "dist"), { recursive: true });
    await symlink(outside, join(fixture.packageRoot, "dist/native"), "dir");

    await expect(resolveRuntimeAssets(fixture)).rejects.toMatchObject({
      code: "ASSET_PATH_INVALID",
      assetId: nativeAsset.id,
    });
  });

  it("并发 staging 由内容目录线性化为一次安装和一次幂等复用", async () => {
    const fixture = await createModelPackFixture();

    const results = await Promise.all([
      stageModelPack(fixture),
      stageModelPack(fixture),
    ]);

    expect(results.map(({ installed }) => installed).sort()).toEqual([false, true]);
    await expect(resolveRuntimeAssets(fixture)).resolves.toMatchObject({
      modelSetFingerprint: MODEL_SET_FINGERPRINT,
    });
  });
});

describe("RuntimeAssets staging 清理与取消", () => {
  it("下一次 staging 清理强杀遗留的临时和损坏目录", async () => {
    const fixture = await createModelPackFixture();
    const modelStoreRoot = join(fixture.dataRoot, "assets");
    const staleStage = ".stage-11111111-1111-4111-8111-111111111111-ABC123";
    const staleDamaged = ".damaged-22222222-2222-4222-8222-222222222222";
    await writeFixtureFile(join(modelStoreRoot, staleStage), "partial", "partial");
    await writeFixtureFile(join(modelStoreRoot, staleDamaged), "partial", "partial");

    await expect(stageModelPack(fixture)).resolves.toMatchObject({ installed: true });

    await expect(readdir(modelStoreRoot)).resolves.toEqual([MODEL_SET_FINGERPRINT]);
  });

  it("在读取归档前拒绝超过 768 MiB 的 sparse 文件", async () => {
    const fixture = await createModelPackFixture();
    await truncate(fixture.modelPackPath, 768 * 1024 * 1024 + 1);

    await expect(stageModelPack(fixture)).rejects.toMatchObject({ code: "MODEL_PACK_INVALID" });
    const entries = await readdir(join(fixture.dataRoot, "assets")).catch(() => []);
    expect(entries).toEqual([]);
  });

  it("取消 staging 后清除临时目录且不产生可解析模型集", async () => {
    const fixture = await createModelPackFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(stageModelPack({ ...fixture, signal: controller.signal })).rejects.toMatchObject({
      code: "STAGE_ABORTED",
    });
    const entries = await readdir(join(fixture.dataRoot, "assets")).catch(() => []);
    expect(entries).toEqual([]);
    await expect(resolveRuntimeAssets(fixture)).rejects.toMatchObject({ code: "ASSET_MISSING" });
  });
});

describe("RuntimeAssets staging 清单边界", () => {
  it("拒绝把相同模型记录的 kind 对调到错误运行根", async () => {
    const fixture = await createModelPackFixture({
      runtimeAssets: [configAsset, modelAsset],
      packAssets: [
        { ...configAsset, kind: "model" },
        { ...modelAsset, kind: "config" },
      ],
      assetBytes: {
        [configAsset.relativePath]: Buffer.from("config bytes"),
        [modelAsset.relativePath]: MODEL_BYTES,
      },
      modelSetFingerprint: TWO_ASSET_FINGERPRINT,
    });

    await expect(stageModelPack(fixture)).rejects.toMatchObject({
      code: "MODEL_PACK_INCOMPATIBLE",
    });
  });

  it("拒绝 native 记录借模型路径跨越双根边界", async () => {
    const misplacedNative = { ...nativeAsset, relativePath: "models/example.node" };
    const fixture = await createModelPackFixture({
      runtimeAssets: [modelAsset, misplacedNative],
      packAssets: [modelAsset],
    });

    await expect(resolveRuntimeAssets(fixture)).rejects.toMatchObject({
      code: "MANIFEST_INVALID",
    });
  });

  it("只安装 fingerprint 覆盖的模型字节，不把法务材料混入内容目录", async () => {
    const fixture = await createModelPackFixture();
    await stageModelPack(fixture);
    const modelRoot = join(fixture.dataRoot, "assets", MODEL_SET_FINGERPRINT);

    await expect(readFile(join(modelRoot, "LICENSE"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(modelRoot, "THIRD_PARTY_NOTICES.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(modelRoot, "model-pack.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
