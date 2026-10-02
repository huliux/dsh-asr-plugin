import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  doctorRuntimeAssets,
  resolveRuntimeAssets,
  stageModelPack,
} from "../../src/assets/runtime-assets.js";
import {
  addDoctorRuntime,
  cleanupRuntimeAssetsFixtures,
  createModelPackFixture,
  MODEL_BYTES,
  MODEL_SET_FINGERPRINT,
  modelAsset,
  nativeAsset,
} from "../helpers/runtime-assets-fixture.js";

afterEach(cleanupRuntimeAssetsFixtures);

describe("RuntimeAssets doctor 健康状态", () => {
  it("doctor 汇总模型、包内 native 与 ORT 的 content-free 健康状态", async () => {
    const fixture = await createModelPackFixture({
      runtimeAssets: [modelAsset, nativeAsset],
      packAssets: [modelAsset],
    });
    await stageModelPack(fixture);
    await addDoctorRuntime(fixture);

    await expect(doctorRuntimeAssets(fixture)).resolves.toMatchObject({
      ready: true,
      modelSetFingerprint: MODEL_SET_FINGERPRINT,
      checks: [
        { id: "example-model", kind: "model", status: "ok", hashStatus: "ok" },
        { id: "example-native", kind: "native", status: "ok", hashStatus: "ok" },
        {
          id: "onnxruntime-node",
          kind: "dependency",
          status: "ok",
          hashStatus: "ok",
          version: "1.19.2",
        },
      ],
      issues: [],
    });
  });
});

describe("RuntimeAssets doctor 损坏修复", () => {
  it("doctor 建议重新 staging 后可用合法模型包原子修复损坏安装", async () => {
    const fixture = await createModelPackFixture({
      runtimeAssets: [modelAsset, nativeAsset],
      packAssets: [modelAsset],
    });
    await stageModelPack(fixture);
    await addDoctorRuntime(fixture);
    const installedModel = join(
      fixture.dataRoot,
      "assets",
      MODEL_SET_FINGERPRINT,
      modelAsset.relativePath,
    );
    await writeFile(installedModel, Buffer.from("broken data"));

    await expect(doctorRuntimeAssets(fixture)).resolves.toMatchObject({
      ready: false,
      issues: [{ id: modelAsset.id, action: "restage_model_pack" }],
    });
    await expect(stageModelPack(fixture)).resolves.toMatchObject({ installed: true });
    await expect(doctorRuntimeAssets(fixture)).resolves.toMatchObject({
      ready: true,
      issues: [],
    });
    await expect(readFile(installedModel)).resolves.toEqual(MODEL_BYTES);
  });
});

describe("RuntimeAssets doctor 并发与取消", () => {
  it("并发修复同一损坏模型集只提交一个已验证安装", async () => {
    const fixture = await createModelPackFixture();
    await stageModelPack(fixture);
    const installedModel = join(
      fixture.dataRoot,
      "assets",
      MODEL_SET_FINGERPRINT,
      modelAsset.relativePath,
    );
    await writeFile(installedModel, Buffer.from("broken data"));

    const repaired = await Promise.all([
      stageModelPack(fixture),
      stageModelPack(fixture),
    ]);

    expect(repaired.map(({ installed }) => installed).sort()).toEqual([false, true]);
    await expect(resolveRuntimeAssets(fixture)).resolves.toBeDefined();
    await expect(readFile(installedModel)).resolves.toEqual(MODEL_BYTES);
  });

  it("修复归档被取消时保留原损坏安装且不暴露半成品", async () => {
    const fixture = await createModelPackFixture();
    await stageModelPack(fixture);
    const installedModel = join(
      fixture.dataRoot,
      "assets",
      MODEL_SET_FINGERPRINT,
      modelAsset.relativePath,
    );
    const broken = Buffer.from("broken data");
    await writeFile(installedModel, broken);
    const cancellation = new AbortController();
    cancellation.abort();

    await expect(stageModelPack({ ...fixture, signal: cancellation.signal })).rejects.toMatchObject({
      code: "STAGE_ABORTED",
    });
    await expect(readFile(installedModel)).resolves.toEqual(broken);
    await expect(readdir(join(fixture.dataRoot, "assets"))).resolves.toEqual([
      MODEL_SET_FINGERPRINT,
    ]);
  });
});

describe("RuntimeAssets doctor 恢复指引", () => {
  it("权限损坏经 doctor 指向 restage 后可由合法模型包修复", async () => {
    const fixture = await createModelPackFixture({
      runtimeAssets: [modelAsset, nativeAsset],
      packAssets: [modelAsset],
    });
    await stageModelPack(fixture);
    await addDoctorRuntime(fixture);
    const installedModel = join(
      fixture.dataRoot,
      "assets",
      MODEL_SET_FINGERPRINT,
      modelAsset.relativePath,
    );
    await chmod(installedModel, 0o000);

    await expect(doctorRuntimeAssets(fixture)).resolves.toMatchObject({
      ready: false,
      issues: [{
        id: modelAsset.id,
        code: "ASSET_PATH_INVALID",
        action: "restage_model_pack",
      }],
    });
    await expect(stageModelPack(fixture)).resolves.toMatchObject({ installed: true });
    await expect(doctorRuntimeAssets(fixture)).resolves.toMatchObject({ ready: true });
  });

  it("供应链清单缺失时 doctor 返回稳定的重装插件指引", async () => {
    const fixture = await createModelPackFixture();
    await stageModelPack(fixture);

    await expect(doctorRuntimeAssets(fixture)).resolves.toMatchObject({
      ready: false,
      checks: [{
        id: "supply-chain-manifest",
        kind: "package",
        status: "error",
        hashStatus: "not_checked",
      }],
      issues: [{
        id: "supply-chain-manifest",
        code: "SUPPLY_CHAIN_INVALID",
        action: "reinstall_plugin",
      }],
    });
  });
});

describe("RuntimeAssets doctor pnpm 解析", () => {
  it("doctor 按插件解析锚点找到 pnpm 虚拟存储中的 sibling ORT", async () => {
    const fixture = await createModelPackFixture({
      runtimeAssets: [modelAsset, nativeAsset],
      packAssets: [modelAsset],
    });
    await stageModelPack(fixture);
    await addDoctorRuntime(fixture, { pnpmSibling: true });

    await expect(doctorRuntimeAssets(fixture)).resolves.toMatchObject({
      ready: true,
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: "onnxruntime-node",
          kind: "dependency",
          status: "ok",
          hashStatus: "ok",
        }),
      ]),
      issues: [],
    });
  });
});

describe("RuntimeAssets doctor ABI 诊断", () => {
  it("doctor 将 native ABI 错配报告为可行动且不含路径的错误", async () => {
    const incompatibleNative = {
      ...nativeAsset,
      runtime: { ...nativeAsset.runtime!, architecture: "x64" },
    };
    const fixture = await createModelPackFixture({
      runtimeAssets: [modelAsset, incompatibleNative],
      packAssets: [modelAsset],
    });
    await stageModelPack(fixture);
    await addDoctorRuntime(fixture);

    const report = await doctorRuntimeAssets(fixture);
    expect(report).toMatchObject({
      ready: false,
      checks: [
        { id: "example-model", status: "ok" },
        { id: "example-native", status: "error", hashStatus: "not_checked" },
        { id: "onnxruntime-node", status: "ok" },
      ],
      issues: [{
        id: "example-native",
        code: "RUNTIME_MISMATCH",
        action: "use_compatible_runtime",
      }],
    });
    expect(JSON.stringify(report)).not.toContain(fixture.packageRoot);
    expect(JSON.stringify(report)).not.toContain(fixture.dataRoot);
  });
});
