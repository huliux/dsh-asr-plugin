import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareDownloadCache, restoreDownloadedAsset, retainDownloadedAsset } from "../../src/assets/model-download-cache.js";
import type { AssetRecord } from "../../src/assets/verify-assets.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "asr-download-cache-")); roots.push(root);
  const bytes = Buffer.from("verified synthetic model");
  const asset: AssetRecord = { kind: "model", id: "fixture-model", relativePath: "models/fixture.onnx",
    byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const manifest = join(root, "manifest.json"), source = join(root, "source");
  await writeFile(manifest, JSON.stringify({ schemaVersion: 2, algorithmRevision: "fixture-v1", assets: [asset] }));
  await writeFile(source, bytes, { mode: 0o600 });
  return { root, bytes, asset, manifest, source, cache: await prepareDownloadCache(root, "base") };
}
it("reuses fully verified files without changing their bytes", async () => {
  const value = await fixture(), destination = join(value.root, "restored");
  expect(await restoreDownloadedAsset(value.cache, value.manifest, value.asset, destination, new AbortController().signal)).toBe(false);
  await retainDownloadedAsset(value.cache, value.asset, value.source);
  expect(await restoreDownloadedAsset(value.cache, value.manifest, value.asset, destination, new AbortController().signal)).toBe(true);
  expect(await readFile(destination)).toEqual(value.bytes);
});
it("rejects changed bytes and allows replacing an invalid cache file", async () => {
  const value = await fixture(), destination = join(value.root, "restored");
  await retainDownloadedAsset(value.cache, value.asset, value.source);
  await writeFile(join(value.cache, value.asset.relativePath), Buffer.alloc(value.bytes.length));
  expect(await restoreDownloadedAsset(value.cache, value.manifest, value.asset, destination, new AbortController().signal)).toBe(false);
  await retainDownloadedAsset(value.cache, value.asset, value.source);
  expect(await restoreDownloadedAsset(value.cache, value.manifest, value.asset, destination, new AbortController().signal)).toBe(true);
});
it("does not copy a verified cache file after cancellation", async () => {
  const value = await fixture();
  await retainDownloadedAsset(value.cache, value.asset, value.source);
  await expect(restoreDownloadedAsset(value.cache, value.manifest, value.asset, join(value.root, "restored"),
    AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
});
it("rejects a cache file symlink rather than reusing it", async () => {
  const value = await fixture();
  await retainDownloadedAsset(value.cache, value.asset, value.source);
  const cached = join(value.cache, value.asset.relativePath);
  await rm(cached); await symlink(value.source, cached);
  await expect(restoreDownloadedAsset(value.cache, value.manifest, value.asset, join(value.root, "restored"),
    new AbortController().signal)).rejects.toMatchObject({ code: "ASSET_PATH_INVALID" });
});
