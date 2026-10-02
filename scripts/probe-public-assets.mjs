import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readSupplyChainManifest } from "../dist/assets/supply-chain.js";
import { readAssetManifest } from "../dist/assets/verify-assets.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeManifestPath = resolve(repositoryRoot, "src/assets/manifest.json");
const supplyChainPath = resolve(repositoryRoot, "src/assets/supply-chain.json");

function transportUrl(asset) {
  const transport = asset.transports.find(({ kind }) => kind === "cn-mirror")
    ?? asset.transports.find(({ kind }) => kind === "canonical");
  if (transport === undefined) throw new Error(`No public transport for ${asset.id}`);
  return transport.url;
}

async function hashResponse(response, assetId) {
  if (!response.ok || response.body === null) {
    throw new Error(`Public source failed for ${assetId}: HTTP ${response.status}`);
  }
  if (new URL(response.url).protocol !== "https:") {
    throw new Error(`Public source redirected outside HTTPS for ${assetId}`);
  }
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of response.body) {
    byteLength += chunk.byteLength;
    hash.update(chunk);
  }
  return { byteLength, sha256: hash.digest("hex") };
}

async function verifyPublicAsset(runtimeAsset, supplyAsset) {
  const startedAt = performance.now();
  const response = await fetch(transportUrl(supplyAsset), {
    redirect: "follow",
    signal: AbortSignal.timeout(15 * 60_000),
  });
  const actual = await hashResponse(response, runtimeAsset.id);
  if (actual.byteLength !== runtimeAsset.byteLength || actual.sha256 !== runtimeAsset.sha256) {
    throw new Error(`Public source bytes do not match runtime manifest for ${runtimeAsset.id}`);
  }
  return {
    id: runtimeAsset.id,
    byteLength: actual.byteLength,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

const [runtimeManifest, supplyChain] = await Promise.all([
  readAssetManifest(runtimeManifestPath),
  readSupplyChainManifest({ runtimeManifestPath, supplyChainPath }),
]);
const supplies = new Map(supplyChain.assets.map((asset) => [asset.id, asset]));
const publicModels = runtimeManifest.assets.filter(({ kind }) => kind !== "native");
const results = [];
for (const runtimeAsset of publicModels) {
  const supplyAsset = supplies.get(runtimeAsset.id);
  if (supplyAsset === undefined || supplyAsset.distribution !== "public") {
    throw new Error(`Missing public source for ${runtimeAsset.id}`);
  }
  const result = await verifyPublicAsset(runtimeAsset, supplyAsset);
  results.push(result);
  process.stdout.write(`${JSON.stringify({ status: "verified", ...result })}\n`);
}
process.stdout.write(`${JSON.stringify({
  status: "completed",
  verified: results.length,
  byteLength: results.reduce((total, result) => total + result.byteLength, 0),
})}\n`);
