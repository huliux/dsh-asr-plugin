import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  materializeClosedPilotNatives,
} from "../../scripts/release/closed-pilot-native.mjs";

const temporaryRoots: string[] = [];

async function createRepositoryFixture(): Promise<string> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "dsh-asr-native-release-unit-"));
  temporaryRoots.push(repositoryRoot);
  await mkdir(resolve(repositoryRoot, "src/assets"), { recursive: true });
  await Promise.all([
    copyJson("src/assets/manifest.json", resolve(repositoryRoot, "src/assets/manifest.json")),
    copyJson(
      "src/assets/supply-chain.json",
      resolve(repositoryRoot, "src/assets/supply-chain.json"),
    ),
  ]);
  return repositoryRoot;
}

async function copyJson(source: string, target: string): Promise<void> {
  await writeFile(target, await readFile(resolve(source)));
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, {
    force: true,
    recursive: true,
  })));
});

describe("closed-pilot native release inventory policy", () => {
  it("rejects any third native record instead of widening the package inventory", async () => {
    const repositoryRoot = await createRepositoryFixture();
    const manifestPath = resolve(repositoryRoot, "src/assets/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      assets: Array<Record<string, unknown>>;
    };
    manifest.assets.push({
      id: "unexpected-native",
      kind: "native",
      relativePath: "native/darwin-arm64/unexpected.node",
      byteLength: 1,
      sha256: "0".repeat(64),
    });
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(materializeClosedPilotNatives({ repositoryRoot })).rejects.toMatchObject({
      name: "ClosedPilotNativeReleaseError",
      code: "RELEASE_POLICY_MISMATCH",
    });
  });

  it("rejects a changed hcluster build target before consuming release inputs", async () => {
    const repositoryRoot = await createRepositoryFixture();
    const supplyChainPath = resolve(repositoryRoot, "src/assets/supply-chain.json");
    const supplyChain = await readFile(supplyChainPath, "utf8");
    await writeFile(supplyChainPath, supplyChain.replace('"napi": 8', '"napi": 9'));

    await expect(materializeClosedPilotNatives({ repositoryRoot })).rejects.toMatchObject({
      name: "ClosedPilotNativeReleaseError",
      code: "RELEASE_POLICY_MISMATCH",
      assetId: "hcluster-native",
    });
  });
});

describe("closed-pilot native release fbank policy", () => {
  it("rejects a changed fbank runtime hash before consuming sources", async () => {
    const repositoryRoot = await createRepositoryFixture();
    const manifestPath = resolve(repositoryRoot, "src/assets/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      assets: Array<Record<string, unknown>>;
    };
    const fbank = manifest.assets.find((asset) => asset.id === "fbank-native");
    if (fbank === undefined) throw new Error("fixture missing fbank-native");
    fbank.sha256 = "0".repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(materializeClosedPilotNatives({ repositoryRoot })).rejects.toMatchObject({
      name: "ClosedPilotNativeReleaseError",
      code: "RELEASE_POLICY_MISMATCH",
      assetId: "fbank-native",
    });
  });

  it("rejects weakened public fbank source facts", async () => {
    const repositoryRoot = await createRepositoryFixture();
    const supplyChainPath = resolve(repositoryRoot, "src/assets/supply-chain.json");
    const supplyChain = JSON.parse(await readFile(supplyChainPath, "utf8")) as {
      assets: Array<Record<string, unknown>>;
    };
    const fbank = supplyChain.assets.find((asset) => asset.id === "fbank-native");
    if (fbank === undefined) throw new Error("fixture missing fbank-native");
    fbank.sourceMode = "reuse";
    await writeFile(supplyChainPath, JSON.stringify(supplyChain));

    await expect(materializeClosedPilotNatives({ repositoryRoot })).rejects.toMatchObject({
      name: "ClosedPilotNativeReleaseError",
      code: "RELEASE_POLICY_MISMATCH",
      assetId: "fbank-native",
    });
  });
});

describe("closed-pilot native release input boundary", () => {
  it("rejects a missing fbank source closure", async () => {
    const repositoryRoot = await createRepositoryFixture();

    await expect(materializeClosedPilotNatives({ repositoryRoot })).rejects.toMatchObject({
      name: "ClosedPilotNativeReleaseError",
      code: "RELEASE_BUILD_FAILED",
      assetId: "fbank-native",
    });
  });

  it("does not follow a source symlink into data/assets", async () => {
    const repositoryRoot = await createRepositoryFixture();
    const privateAsset = resolve(repositoryRoot, "data/assets/fbank-binding.gyp");
    await mkdir(resolve(privateAsset, ".."), { recursive: true });
    await writeFile(privateAsset, "{}");
    const sourcePath = resolve(repositoryRoot, "native/fbank/binding.gyp");
    await mkdir(resolve(sourcePath, ".."), { recursive: true });
    await symlink(privateAsset, sourcePath);

    await expect(materializeClosedPilotNatives({ repositoryRoot })).rejects.toMatchObject({
      name: "ClosedPilotNativeReleaseError",
      code: "RELEASE_BUILD_FAILED",
      assetId: "fbank-native",
    });
  });
});

describe("closed-pilot native release output boundary", () => {
  it("refuses an existing native target instead of reusing build residue", async () => {
    const repositoryRoot = await createRepositoryFixture();
    await mkdir(resolve(repositoryRoot, "dist/native/darwin-arm64/build"), { recursive: true });

    await expect(materializeClosedPilotNatives({ repositoryRoot })).rejects.toMatchObject({
      name: "ClosedPilotNativeReleaseError",
      code: "RELEASE_OUTPUT_NOT_CLEAN",
    });
  });
});
