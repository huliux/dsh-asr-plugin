import { afterEach, expect, it } from "vitest";
import { readModelSettings } from "../../src/assets/model-settings.js";
import { addDoctorRuntime, cleanupRuntimeAssetsFixtures, createModelPackFixture, modelAsset, nativeAsset } from "../helpers/runtime-assets-fixture.js";

afterEach(cleanupRuntimeAssetsFixtures);
it("reports a fresh installation as base with missing models and verified native dependencies", async () => {
  const fixture = await createModelPackFixture({ runtimeAssets: [modelAsset, nativeAsset], packAssets: [modelAsset] });
  await addDoctorRuntime(fixture);
  expect(await readModelSettings(fixture)).toMatchObject({
    mode: "base", preference: null, inheritedLegacy: false, selectedReady: false,
    base: { state: "missing" }, native: { state: "ready" },
  });
});
