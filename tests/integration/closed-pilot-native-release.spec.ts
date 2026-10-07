import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  materializeClosedPilotNatives,
  verifyClosedPilotPackInventory,
} from "../../scripts/release/closed-pilot-native.mjs";

const suite = describe.skipIf(process.env.DSH_RUN_P1B_NATIVE_RELEASE !== "1");
const repositoryRoot = resolve(".");
let fixtureRoot: string;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-asr-native-release-integration-"));
  await materializeFixture(fixtureRoot);
});

afterAll(async () => {
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { force: true, recursive: true });
});

suite("closed-pilot native release integration", () => {
  it("reproduces pinned natives without inheriting the global Apple toolchain", async () => {
    vi.stubEnv("DEVELOPER_DIR", undefined);
    vi.stubEnv("CC", "/unqualified/clang");
    vi.stubEnv("CXX", "/unqualified/clang++");
    vi.stubEnv("SDKROOT", "/unqualified/MacOSX.sdk");
    try {
      const report = await materializeClosedPilotNatives({ repositoryRoot: fixtureRoot });

      expect(report).toEqual({
        assets: [
          {
            path: "dist/native/darwin-arm64/fbank.node",
            byteLength: 141_448,
            sha256: "62c2b1077eefaa9ada40a9fdc4b8e6a0bfd248084336be130310dab7f57c4438",
          },
          {
            path: "dist/native/darwin-arm64/hcluster.node",
            byteLength: 131_536,
            sha256: "ebc22050bd12065c9fb03d90ed7ed39b481edb65559cedd88af80200c8e63688",
          },
        ],
      });
      const outputFiles = await Promise.all(report.assets.map(async (asset) => ({
        ...asset,
        bytes: (await readFile(resolve(fixtureRoot, asset.path))).byteLength,
      })));
      expect(outputFiles.map(({ bytes, ...asset }) => ({ ...asset, byteLength: bytes })))
        .toEqual(report.assets);
      await expect(readFile(resolve(
        fixtureRoot,
        "dist/native/darwin-arm64/build/Release/hcluster.node",
      ))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(verifyClosedPilotPackInventory({
        repositoryRoot: fixtureRoot,
        packedPaths: ["package.json", ...report.assets.map((asset) => asset.path)],
      })).resolves.toEqual(report);
    } finally { vi.unstubAllEnvs(); }
  }, 120_000);

  it("rejects an explicit unavailable toolchain with a setup instruction", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-asr-native-toolchain-rejection-"));
    try {
      await materializeFixture(root);
      vi.stubEnv("DEVELOPER_DIR", "/unavailable/developer-tools");
      await expect(materializeClosedPilotNatives({ repositoryRoot: root })).rejects.toMatchObject({
        code: "RELEASE_BUILD_FAILED", assetId: "fbank-native",
        message: expect.stringContaining("DEVELOPER_DIR"),
      });
      await expect(readFile(resolve(root, "dist/native/darwin-arm64/fbank.node")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally { vi.unstubAllEnvs(); await rm(root, { force: true, recursive: true }); }
  });
});

async function materializeFixture(targetRoot: string): Promise<void> {
  await Promise.all([
    copyFileInto("src/assets/manifest.json", targetRoot),
    copyFileInto("src/assets/supply-chain.json", targetRoot),
    copyFbankSources(targetRoot),
    copyHclusterSources(targetRoot),
    linkBuildTool("node-addon-api", targetRoot),
    linkBuildTool("node-gyp", targetRoot),
  ]);
  const residue = resolve(targetRoot, "native/hcluster/build/Release/hcluster.node");
  await mkdir(dirname(residue), { recursive: true });
  await writeFile(residue, "must-not-be-consumed");
}

async function copyFileInto(relativePath: string, targetRoot: string): Promise<void> {
  const target = resolve(targetRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(repositoryRoot, relativePath), target);
}

async function copyHclusterSources(targetRoot: string): Promise<void> {
  const target = resolve(targetRoot, "native/hcluster");
  await mkdir(target, { recursive: true });
  await copyFile(
    resolve(repositoryRoot, "native/hcluster/binding.gyp"),
    resolve(target, "binding.gyp"),
  );
  await cp(
    resolve(repositoryRoot, "native/hcluster/vendor"),
    resolve(target, "vendor"),
    { recursive: true },
  );
}

async function copyFbankSources(targetRoot: string): Promise<void> {
  await copyFileInto("native/fbank/binding.gyp", targetRoot);
  await Promise.all(["src", "vendor"].map(async (directory) => {
    await cp(resolve(repositoryRoot, "native/fbank", directory),
      resolve(targetRoot, "native/fbank", directory), { recursive: true });
  }));
}

async function linkBuildTool(packageName: string, targetRoot: string): Promise<void> {
  const targetDirectory = resolve(targetRoot, "node_modules", packageName);
  await mkdir(dirname(targetDirectory), { recursive: true });
  await symlink(await realpath(resolve(repositoryRoot, "node_modules", packageName)), targetDirectory);
}
