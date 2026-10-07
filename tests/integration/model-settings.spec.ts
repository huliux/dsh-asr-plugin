import { afterEach, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readModelSettings } from "../../src/assets/model-settings.js";
import { resolveConfiguredRuntimeAssets, stageModelPack } from "../../src/assets/runtime-assets.js";
import { modelPackFingerprint, modelSetFingerprint } from "../../src/assets/model-pack.js";
import { readAssetManifest } from "../../src/assets/verify-assets.js";
import { addDoctorRuntime, cleanupRuntimeAssetsFixtures, createModelPackFixture, MODEL_BYTES, modelAsset, nativeAsset, writeFixtureFile } from "../helpers/runtime-assets-fixture.js";

afterEach(cleanupRuntimeAssetsFixtures);
it("reports a fresh installation as base with missing models and verified native dependencies", async () => {
  const fixture = await createModelPackFixture({ runtimeAssets: [modelAsset, nativeAsset], packAssets: [modelAsset] });
  await addDoctorRuntime(fixture);
  expect(await readModelSettings(fixture)).toMatchObject({
    mode: "base", preference: null, inheritedLegacy: false, selectedReady: false,
    base: { state: "missing" }, native: { state: "ready" },
  });
});

it("starts base with a verified split pack and an empty leftover legacy directory", async () => {
  const punctuation = { ...modelAsset, id: "punc-model", relativePath: "models/punctuation.onnx" };
  const fixture = await createModelPackFixture({
    runtimeAssets: [modelAsset, punctuation, nativeAsset], packAssets: [modelAsset],
  });
  await addDoctorRuntime(fixture);
  const supplyPath = join(fixture.packageRoot, "dist/assets/supply-chain.json");
  const supply = JSON.parse(await readFile(supplyPath, "utf8"));
  supply.assets.push({ ...supply.assets[0], id: punctuation.id });
  await writeFile(supplyPath, JSON.stringify(supply));
  const manifest = await readAssetManifest(join(fixture.packageRoot, "dist/assets/manifest.json"));
  await mkdir(join(fixture.dataRoot, "assets", modelSetFingerprint(manifest)), { recursive: true });
  await writeFixtureFile(join(fixture.dataRoot, "assets", modelPackFingerprint(manifest, "base")),
    modelAsset.relativePath, MODEL_BYTES);

  expect(await readModelSettings(fixture)).toMatchObject({
    mode: "base", preference: null, inheritedLegacy: false, selectedReady: true,
    base: { state: "ready" }, punctuation: { state: "missing" },
  });
  expect((await resolveConfiguredRuntimeAssets(fixture)).processing?.identity.mode).toBe("base");
  expect(await readModelSettings(fixture, true)).toMatchObject({
    mode: "base", preference: null, inheritedLegacy: false, selectedReady: true,
  });
  expect((await resolveConfiguredRuntimeAssets(fixture, true)).processing?.identity.mode).toBe("base");
});

it("preserves complete legacy mode and ignores obsolete punctuation preferences", async () => {
  const fixture = await createModelPackFixture({ runtimeAssets: [modelAsset, nativeAsset], packAssets: [modelAsset] });
  await addDoctorRuntime(fixture);
  await stageModelPack(fixture);
  expect(await readModelSettings(fixture)).toMatchObject({
    mode: "enhanced", inheritedLegacy: false, selectedReady: true,
  });
  expect((await resolveConfiguredRuntimeAssets(fixture)).processing?.identity.mode).toBe("enhanced");
  expect(await readModelSettings(fixture, false)).toMatchObject({ mode: "enhanced", inheritedLegacy: false });

  const manifest = await readAssetManifest(join(fixture.packageRoot, "dist/assets/manifest.json"));
  await writeFixtureFile(join(fixture.dataRoot, "assets", modelSetFingerprint(manifest)),
    modelAsset.relativePath, "wrong bytes");
  expect(await readModelSettings(fixture)).toMatchObject({ mode: "base", inheritedLegacy: false });
  await expect(resolveConfiguredRuntimeAssets(fixture, true)).rejects.toMatchObject({ code: "MODEL_NOT_READY" });
});
