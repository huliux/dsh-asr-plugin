import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  verifyPackedExecutableModes,
  verifyClosedPilotPackInventory,
  verifyPackedFbankDisclosure,
} from "../../scripts/release/closed-pilot-native.mjs";

const nativePaths = [
  "dist/native/darwin-arm64/fbank.node",
  "dist/native/darwin-arm64/hcluster.node",
];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, {
    force: true,
    recursive: true,
  })));
});

describe("closed-pilot pack inventory gate", () => {
  it("checks source, manifest and license facts inside the packed artifact", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "dsh-asr-packed-fbank-"));
    temporaryRoots.push(packageRoot);
    const paths = [
      "dist/assets/manifest.json", "dist/assets/supply-chain.json",
      "THIRD_PARTY_NOTICES.md", "LICENSE",
      "third_party/licenses/MIT-node-addon-api.md",
      "third_party/licenses/Ooura-FFT.txt",
    ];
    await Promise.all(paths.map(async (path) => {
      const target = join(packageRoot, path);
      await mkdir(join(target, ".."), { recursive: true });
      const source = path.startsWith("dist/assets/")
        ? path.replace("dist/assets/", "src/assets/") : path;
      await copyFile(resolve(source), target);
    }));

    await expect(verifyPackedFbankDisclosure({ packageRoot }))
      .resolves.toMatchObject({ assetId: "fbank-native" });

    const noticePath = join(packageRoot, "THIRD_PARTY_NOTICES.md");
    const notice = await readFile(noticePath, "utf8");
    await writeFile(noticePath, notice.replace("Ooura-FFT.txt", "missing-license.txt"));
    await expect(verifyPackedFbankDisclosure({ packageRoot })).rejects.toMatchObject({
      code: "RELEASE_PACK_INVALID", assetId: "fbank-native",
    });
  });

  it("requires both and only both pinned native package members", async () => {
    await expect(verifyClosedPilotPackInventory({
      repositoryRoot: "/not-read-before-inventory-is-valid",
      packedPaths: ["package.json", nativePaths[0]!],
    })).rejects.toMatchObject({
      name: "ClosedPilotNativeReleaseError",
      code: "RELEASE_PACK_INVALID",
    });
  });

  it.each([
    "data/release-staging/closed-pilot/darwin-arm64/fbank.node",
    "native/hcluster/build/Release/hcluster.node",
    "dist/native/build/Release/hcluster.node",
    "dist/private-audio/sample.mp3",
    "dist/models/asr/model.onnx",
    "dist/probes/private-corpus.js",
    "dist/maintenance/model-pack-builder.js",
    "dist/../../data/meetings.sqlite",
  ])("rejects forbidden or private package member %s", async (forbiddenPath) => {
    await expect(verifyClosedPilotPackInventory({
      repositoryRoot: "/not-read-before-inventory-is-valid",
      packedPaths: ["package.json", ...nativePaths, forbiddenPath],
    })).rejects.toThrow(/forbidden/i);
  });

  it("rejects duplicate package members", async () => {
    await expect(verifyClosedPilotPackInventory({
      repositoryRoot: "/not-read-before-inventory-is-valid",
      packedPaths: ["package.json", ...nativePaths, nativePaths[0]!],
    })).rejects.toThrow(/duplicate/i);
  });

  it("rejects a packed Helper whose executable bit was normalized away", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "dsh-asr-packed-helper-"));
    temporaryRoots.push(packageRoot);
    const executablePath = "dist/recording-helper/Test.app/Contents/MacOS/Test";
    const absolutePath = join(packageRoot, executablePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, "fixture");
    await chmod(absolutePath, 0o644);

    await expect(verifyPackedExecutableModes({
      executablePaths: [executablePath],
      packageRoot,
    })).rejects.toMatchObject({
      name: "ClosedPilotNativeReleaseError",
      code: "RELEASE_PACK_INVALID",
    });

    await chmod(absolutePath, 0o755);
    await expect(verifyPackedExecutableModes({
      executablePaths: [executablePath],
      packageRoot,
    })).resolves.toEqual({ executablePaths: [executablePath] });
  });
});
