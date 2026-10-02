import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readSupplyChainManifest,
  renderThirdPartyNotices,
} from "../dist/assets/supply-chain.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeManifestPath = resolve(repositoryRoot, "src/assets/manifest.json");
const supplyChainPath = resolve(repositoryRoot, "src/assets/supply-chain.json");
const assetDestination = resolve(repositoryRoot, "dist/assets");
const noticeDestination = resolve(repositoryRoot, "dist/THIRD_PARTY_NOTICES.md");

await mkdir(assetDestination, { recursive: true });
await Promise.all([
  copyFile(runtimeManifestPath, resolve(assetDestination, "manifest.json")),
  copyFile(supplyChainPath, resolve(assetDestination, "supply-chain.json")),
  copyFile(resolve(repositoryRoot, "LICENSE"), resolve(repositoryRoot, "dist/LICENSE")),
]);
const manifest = await readSupplyChainManifest({ runtimeManifestPath, supplyChainPath });
await writeFile(noticeDestination, renderThirdPartyNotices(manifest), "utf8");
