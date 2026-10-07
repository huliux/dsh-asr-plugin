import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { doctorRuntimeAssets, resolveConfiguredRuntimeAssets, resolveRuntimeAssets, stageModelPack } from "../../src/assets/runtime-assets.js";
import { createPackagedWorkerLaunch } from "../../src/worker/launch.js";
import { parseWorkerEntryConfig } from "../../src/worker/entry-config.js";
import { loadWorkerAssets } from "../../src/worker/worker-assets.js";
import { acquireModelStageLease } from "../../src/assets/runtime-assets-stage-lease.js";
import { readModelSettings } from "../../src/assets/model-settings.js";
import { buildModelPack } from "../../src/maintenance/model-pack-builder.js";
import {
  addDoctorRuntime, cleanupRuntimeAssetsFixtures, createModelPackFixture,
  MODEL_BYTES, modelAsset, nativeAsset,
} from "../helpers/runtime-assets-fixture.js";

const punctuationAsset = {
  ...modelAsset, id: "punc-model", relativePath: "models/punc/model.onnx",
};

async function splitFixture() {
  const fixture = await createModelPackFixture({
    runtimeAssets: [modelAsset, punctuationAsset, nativeAsset],
    packAssets: [modelAsset, punctuationAsset],
    assetBytes: {
      [modelAsset.relativePath]: MODEL_BYTES,
      [punctuationAsset.relativePath]: MODEL_BYTES,
    },
  });
  await addDoctorRuntime(fixture);
  const supplyPath = join(fixture.packageRoot, "dist/assets/supply-chain.json");
  const supply = JSON.parse(await readFile(supplyPath, "utf8"));
  supply.assets.push({ ...supply.assets[0], id: punctuationAsset.id });
  await writeFile(supplyPath, JSON.stringify(supply));
  return fixture;
}

afterEach(cleanupRuntimeAssetsFixtures);

describe("independent model pack delivery", () => {

  it("resolves explicit base mode without punctuation and blocks enabled missing punctuation", async () => {
    const fixture = await splitFixture();
    const outputPath = join(fixture.archiveRoot, "base.tar");
    const pack = await buildModelPack({ modelRoot: fixture.archiveRoot, outputPath,
      packageRoot: fixture.packageRoot, pack: "base" });
    await stageModelPack({ ...fixture, modelPackPath: outputPath });
    const resolved = await resolveRuntimeAssets({ ...fixture, mode: "base" });
    expect(resolved.modelRoot).toBe(join(fixture.dataRoot, "assets", pack.modelSetFingerprint));
    expect(resolved.processing).toMatchObject({ punctuationRoot: null, identity: {
      mode: "base", baseModelFingerprint: pack.modelSetFingerprint,
      punctuationModelFingerprint: null, engineFingerprint: resolved.engineFingerprint,
    } });
    await expect(resolveRuntimeAssets({ ...fixture, mode: "enhanced" }))
      .rejects.toMatchObject({ code: "MODEL_NOT_READY", assetId: "punc-model" });
  });

  it("validates selected mode and model identity at the Worker launch boundary", async () => {
    const fixture = await splitFixture();
    for (const pack of ["base", "punctuation"] as const) {
      const outputPath = join(fixture.archiveRoot, `${pack}.tar`);
      await buildModelPack({ modelRoot: fixture.archiveRoot, outputPath,
        packageRoot: fixture.packageRoot, pack });
      await stageModelPack({ ...fixture, modelPackPath: outputPath });
    }
    const base = await resolveRuntimeAssets({ ...fixture, mode: "base" });
    const enhanced = await resolveRuntimeAssets({ ...fixture, mode: "enhanced" });
    expect(base.engineFingerprint).not.toBe(enhanced.engineFingerprint);
    const launch = createPackagedWorkerLaunch({ ...base, kind: "asr",
      managedAudioDirectory: fixture.dataRoot, graceMs: 1_000 });
    const config = parseWorkerEntryConfig(launch.argv.slice(2));
    const verified = await loadWorkerAssets(config, [modelAsset.id, punctuationAsset.id, nativeAsset.id]);
    expect(verified.engineFingerprint).toBe(base.engineFingerprint);
    expect(Object.keys(verified.paths).sort()).toEqual([modelAsset.id, nativeAsset.id].sort());
    const forged = { ...config, processing: { ...enhanced.processing!,
      identity: { ...enhanced.processing!.identity, engineFingerprint: base.engineFingerprint } } };
    await expect(loadWorkerAssets(forged, [modelAsset.id, punctuationAsset.id, nativeAsset.id]))
      .rejects.toMatchObject({ code: "ASSET_MISMATCH" });
    const enhancedConfig = parseWorkerEntryConfig(createPackagedWorkerLaunch({ ...enhanced,
      kind: "asr", managedAudioDirectory: fixture.dataRoot, graceMs: 1_000 }).argv.slice(2));
    expect((await loadWorkerAssets(enhancedConfig, [modelAsset.id, punctuationAsset.id])).paths)
      .toHaveProperty(punctuationAsset.id,
        join(enhanced.processing!.punctuationRoot!, punctuationAsset.relativePath));
  });

  it("automatically uses verified split punctuation without changing an existing run", async () => {
    const fixture = await splitFixture();
    let baseRun;
    for (const pack of ["base", "punctuation"] as const) {
      const outputPath = join(fixture.archiveRoot, `${pack}.tar`);
      await buildModelPack({ modelRoot: fixture.archiveRoot, outputPath,
        packageRoot: fixture.packageRoot, pack });
      await stageModelPack({ ...fixture, modelPackPath: outputPath });
      if (pack === "base") {
        baseRun = await resolveConfiguredRuntimeAssets(fixture);
        expect(baseRun.processing?.identity.mode).toBe("base");
      }
    }
    expect((await resolveConfiguredRuntimeAssets(fixture)).processing?.identity.mode).toBe("enhanced");
    expect(await readModelSettings(fixture)).toMatchObject({ mode: "enhanced", selectedReady: true });
    expect(baseRun?.processing?.identity.mode).toBe("base");
    expect((await resolveConfiguredRuntimeAssets(fixture, true)).processing?.identity.mode).toBe("enhanced");
    const completePath = join(fixture.archiveRoot, "complete.tar");
    await buildModelPack({ modelRoot: fixture.archiveRoot, outputPath: completePath,
      packageRoot: fixture.packageRoot });
    await stageModelPack({ ...fixture, modelPackPath: completePath });
    expect((await resolveConfiguredRuntimeAssets(fixture)).processing?.identity.mode).toBe("enhanced");
    expect((await resolveConfiguredRuntimeAssets(fixture, false)).processing?.identity.mode).toBe("enhanced");
  });
  it("blocks a damaged installed punctuation pack instead of silently switching to base", async () => {
    const fixture = await splitFixture();
    for (const pack of ["base", "punctuation"] as const) {
      const outputPath = join(fixture.archiveRoot, `${pack}.tar`);
      await buildModelPack({ modelRoot: fixture.archiveRoot, outputPath,
        packageRoot: fixture.packageRoot, pack });
      await stageModelPack({ ...fixture, modelPackPath: outputPath });
    }
    const enhanced = await resolveConfiguredRuntimeAssets(fixture);
    await rm(join(enhanced.processing!.punctuationRoot!, punctuationAsset.relativePath));
    await expect(resolveConfiguredRuntimeAssets(fixture)).rejects.toMatchObject({ code: "MODEL_NOT_READY" });
    expect(await readModelSettings(fixture)).toMatchObject({ mode: "enhanced", selectedReady: false });
  });
  it.each(["runtime", "settings"] as const)("waits for punctuation repair before reading %s mode", async (reader) => {
    const fixture = await splitFixture();
    for (const pack of ["base", "punctuation"] as const) {
      const outputPath = join(fixture.archiveRoot, `${pack}.tar`);
      await buildModelPack({ modelRoot: fixture.archiveRoot, outputPath,
        packageRoot: fixture.packageRoot, pack });
      await stageModelPack({ ...fixture, modelPackPath: outputPath });
    }
    const enhanced = await resolveConfiguredRuntimeAssets(fixture);
    const installedRoot = enhanced.processing!.punctuationRoot!;
    const displacedRoot = join(fixture.dataRoot, "assets", ".damaged-repair-test");
    const lease = await acquireModelStageLease(fixture.dataRoot);
    let settled = false;
    let pending: Promise<string> | undefined;
    try {
      await rename(installedRoot, displacedRoot);
      pending = (reader === "runtime"
        ? resolveConfiguredRuntimeAssets(fixture).then(result => result.processing!.identity.mode)
        : readModelSettings(fixture).then(result => {
          expect(result.selectedReady).toBe(true);
          return result.mode;
        })).finally(() => { settled = true; });
      await delay(100);
      expect(settled).toBe(false);
    } finally {
      await rename(displacedRoot, installedRoot);
      await lease[Symbol.asyncDispose]();
    }
    expect(await pending).toBe("enhanced");
  });

  it("requires public provenance and rejects changed provenance without losing base", async () => {
    const fixture = await splitFixture();
    const basePath = join(fixture.archiveRoot, "base.tar");
    await buildModelPack({ modelRoot: fixture.archiveRoot, outputPath: basePath,
      packageRoot: fixture.packageRoot, pack: "base" });
    await stageModelPack({ ...fixture, modelPackPath: basePath });
    const supplyPath = join(fixture.packageRoot, "dist/assets/supply-chain.json");
    const original = await readFile(supplyPath, "utf8");
    const supply = JSON.parse(original);
    supply.assets[0].distribution = "closed-pilot-only";
    await writeFile(supplyPath, JSON.stringify(supply));
    await expect(buildModelPack({ modelRoot: fixture.archiveRoot,
      outputPath: join(fixture.archiveRoot, "private.tar"),
      packageRoot: fixture.packageRoot, pack: "base" }))
      .rejects.toMatchObject({ code: "MODEL_PACK_BUILD_INVALID" });
    await expect(stageModelPack({ ...fixture, modelPackPath: basePath }))
      .rejects.toMatchObject({ code: "MODEL_PACK_INCOMPATIBLE" });
    await writeFile(supplyPath, original);
    expect(await doctorRuntimeAssets(fixture)).toMatchObject({ ready: true, enhancedReady: false });
  });

  it("allows punctuation first without claiming the required base is installed", async () => {
    const fixture = await splitFixture();
    const outputPath = join(fixture.archiveRoot, "punctuation.tar");
    await buildModelPack({ modelRoot: fixture.archiveRoot, outputPath,
      packageRoot: fixture.packageRoot, pack: "punctuation" });
    await stageModelPack({ ...fixture, modelPackPath: outputPath });
    expect(await doctorRuntimeAssets(fixture)).toMatchObject({
      ready: false, enhancedReady: false,
      groups: { base: { ready: false }, punctuation: { ready: true } },
    });
  });

  it("preserves both installed packs on corrupt, incompatible and cancelled imports", async () => {
    const fixture = await splitFixture();
    const built = [];
    for (const pack of ["base", "punctuation"] as const) {
      const outputPath = join(fixture.archiveRoot, `${pack}.tar`);
      const result = await buildModelPack({ modelRoot: fixture.archiveRoot, outputPath,
        packageRoot: fixture.packageRoot, pack });
      built.push({ ...result, outputPath });
      await stageModelPack({ ...fixture, modelPackPath: outputPath });
      await expect(stageModelPack({ ...fixture, modelPackPath: outputPath }))
        .resolves.toMatchObject({ installed: false });
    }
    const corruptPath = join(fixture.archiveRoot, "corrupt.tar");
    const corrupt = await readFile(built[1]!.outputPath);
    const payloadOffset = corrupt.indexOf(MODEL_BYTES);
    corrupt[payloadOffset] = corrupt[payloadOffset]! ^ 1;
    await writeFile(corruptPath, corrupt);
    await expect(stageModelPack({ ...fixture, modelPackPath: corruptPath }))
      .rejects.toMatchObject({ code: "MODEL_PACK_INVALID" });
    const other = await splitFixture();
    const manifestPath = join(other.packageRoot, "dist/assets/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.assets[0].sha256 = "0".repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const incompatiblePath = join(other.archiveRoot, "different-runtime.tar");
    await buildModelPack({ modelRoot: other.archiveRoot, outputPath: incompatiblePath,
      packageRoot: other.packageRoot, pack: "punctuation" });
    await expect(stageModelPack({ ...fixture, modelPackPath: incompatiblePath }))
      .rejects.toMatchObject({ code: "MODEL_PACK_INCOMPATIBLE" });
    await expect(stageModelPack({ ...fixture, modelPackPath: built[0]!.outputPath,
      signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "STAGE_ABORTED" });
    expect(await doctorRuntimeAssets(fixture)).toMatchObject({ ready: true, enhancedReady: true });
    expect((await readdir(join(fixture.dataRoot, "assets"))).sort())
      .toEqual(built.map((pack) => pack.modelSetFingerprint).sort());
  });

  it("reuses legacy complete installs but never hides a damaged split punctuation pack", async () => {
    const fixture = await splitFixture();
    const completePath = join(fixture.archiveRoot, "complete.tar");
    await buildModelPack({ modelRoot: fixture.archiveRoot, outputPath: completePath,
      packageRoot: fixture.packageRoot });
    await stageModelPack({ ...fixture, modelPackPath: completePath });
    expect(await doctorRuntimeAssets(fixture)).toMatchObject({ ready: true, enhancedReady: true });
    const puncPath = join(fixture.archiveRoot, "punctuation.tar");
    const pack = await buildModelPack({ modelRoot: fixture.archiveRoot, outputPath: puncPath,
      packageRoot: fixture.packageRoot, pack: "punctuation" });
    await stageModelPack({ ...fixture, modelPackPath: puncPath });
    const installed = join(fixture.dataRoot, "assets", pack.modelSetFingerprint,
      punctuationAsset.relativePath);
    await writeFile(installed, "broken data");
    expect(await doctorRuntimeAssets(fixture)).toMatchObject({
      ready: true, enhancedReady: false,
      groups: { punctuation: { ready: false, issues: [{ code: "ASSET_HASH_MISMATCH" }] } },
    });
    await stageModelPack({ ...fixture, modelPackPath: puncPath });
    await expect(readFile(installed)).resolves.toEqual(MODEL_BYTES);
  });

  it("reports base readiness separately and installs punctuation without touching base", async () => {
    const fixture = await splitFixture();
    const basePath = join(fixture.archiveRoot, "base.tar");
    const puncPath = join(fixture.archiveRoot, "punctuation.tar");
    const base = await buildModelPack({
      modelRoot: fixture.archiveRoot, outputPath: basePath, packageRoot: fixture.packageRoot,
      pack: "base",
    });
    await stageModelPack({ ...fixture, modelPackPath: basePath });
    expect(await doctorRuntimeAssets(fixture)).toMatchObject({
      ready: true, enhancedReady: false, issues: [],
      groups: { base: { ready: true }, punctuation: { ready: false }, native: { ready: true } },
    });
    const punctuation = await buildModelPack({
      modelRoot: fixture.archiveRoot, outputPath: puncPath, packageRoot: fixture.packageRoot,
      pack: "punctuation",
    });
    expect(punctuation.modelSetFingerprint).not.toBe(base.modelSetFingerprint);
    await stageModelPack({ ...fixture, modelPackPath: puncPath });
    expect(await doctorRuntimeAssets(fixture)).toMatchObject({ ready: true, enhancedReady: true });
    await expect(readFile(join(fixture.dataRoot, "assets", base.modelSetFingerprint,
      modelAsset.relativePath))).resolves.toEqual(MODEL_BYTES);
  });

  it("builds and installs the base pack without reading or delivering punctuation", async () => {
    const fixture = await splitFixture();
    await rm(join(fixture.archiveRoot, punctuationAsset.relativePath));
    const outputPath = join(fixture.archiveRoot, "base.tar");
    const built = await buildModelPack({
      modelRoot: fixture.archiveRoot, outputPath, packageRoot: fixture.packageRoot, pack: "base",
    });
    expect(built.assetCount).toBe(1);
    const staged = await stageModelPack({ ...fixture, modelPackPath: outputPath });
    const installedRoot = join(fixture.dataRoot, "assets", staged.modelSetFingerprint);
    await expect(readFile(join(installedRoot, modelAsset.relativePath))).resolves.toEqual(MODEL_BYTES);
    await expect(readFile(join(installedRoot, punctuationAsset.relativePath)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
