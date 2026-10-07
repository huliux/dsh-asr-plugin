import { createHash } from "node:crypto";
import files from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { resolveConfiguredRuntimeAssets, resolveRuntimeAssets, stageModelPack } from "../../src/assets/runtime-assets.js";
import { buildModelPack } from "../../src/maintenance/model-pack-builder.js";
import { acquireModelStageLease } from "../../src/assets/runtime-assets-stage-lease.js";
import { addDoctorRuntime, cleanupRuntimeAssetsFixtures, createModelPackFixture, modelAsset, nativeAsset } from "../helpers/runtime-assets-fixture.js";

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await cleanupRuntimeAssetsFixtures();
});

it.each(["configured", "explicit"] as const)("cancels %s validation after its first real file chunk and releases the lease", async mode => {
  const bytes = Buffer.alloc(4 * 1024 * 1024, 7);
  const asset = { ...modelAsset, byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
  const fixture = await createModelPackFixture({ runtimeAssets: [asset, nativeAsset],
    packAssets: [asset], assetBytes: { [asset.relativePath]: bytes } });
  await addDoctorRuntime(fixture);
  const outputPath = join(fixture.archiveRoot, "base.tar");
  await buildModelPack({ modelRoot: fixture.archiveRoot, outputPath, packageRoot: fixture.packageRoot, pack: "base" });
  await stageModelPack({ ...fixture, modelPackPath: outputPath });
  const controller = new AbortController();
  const openFile = files.open;
  let reads = 0;
  vi.spyOn(files, "open").mockImplementation(async (...args) => {
    const handle = await openFile(...args);
    if (String(args[0]).endsWith(asset.relativePath)) {
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs);
        reads++;
        controller.abort();
        return result;
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  const input = { ...fixture, signal: controller.signal, mode: "base" as const };
  const pending = mode === "configured" ? resolveConfiguredRuntimeAssets(input) : resolveRuntimeAssets(input);
  await expect(pending).rejects.toMatchObject({ code: "STAGE_ABORTED" });
  expect(reads).toBe(1);
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  const lease = await acquireModelStageLease(fixture.dataRoot);
  await lease[Symbol.asyncDispose]();
  expect((await resolveConfiguredRuntimeAssets(fixture)).processing?.identity).toBeDefined();
});
