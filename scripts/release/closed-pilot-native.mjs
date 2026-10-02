import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { buildReproducibleFbank } from "./clean-fbank-build.mjs";
import { buildReproducibleHcluster } from "./clean-hcluster-build.mjs";
import { ClosedPilotNativeReleaseError } from "./closed-pilot-native-error.mjs";
import {
  CLOSED_PILOT_NATIVE_ASSETS,
  HCLUSTER_MANIFEST,
  REBUILT_FBANK_MANIFEST,
} from "./native-release-inventory.mjs";

export { ClosedPilotNativeReleaseError } from "./closed-pilot-native-error.mjs";
export {
  CLOSED_PILOT_EXECUTABLE_PATHS,
  verifyClosedPilotPackInventory,
  verifyPackedFbankDisclosure,
  verifyPackedExecutableModes,
} from "./closed-pilot-pack.mjs";

const REBUILT_FBANK_SUPPLY = Object.freeze({
  id: "fbank-native",
  sourceMode: "rebuild",
  canonicalRepository: "https://github.com/csukuangfj/kaldi-native-fbank",
  revision: "fdc395d24dc3e9e48ae1df4f0f6860f6b7d4870e",
  sourcePath: "kaldi-native-fbank/csrc",
  license: "Apache-2.0 AND MIT AND LicenseRef-Ooura-FFT",
  licenseFiles: [
    "LICENSE",
    "third_party/licenses/MIT-node-addon-api.md",
    "third_party/licenses/Ooura-FFT.txt",
  ],
  distribution: "public",
  transports: [{ kind: "vendored-source" }],
  buildTarget: { platform: "darwin", architecture: "arm64", napi: 10 },
});
const HCLUSTER_SUPPLY = Object.freeze({
  id: "hcluster-native",
  sourceMode: "rebuild",
  canonicalRepository: "https://github.com/kunji163/clerki",
  revision: "44887f62f7b1a69fcc9d23583aa8df8f11898aca",
  sourcePath: "hclust-cpp",
  license: "BSD-2-Clause AND MIT",
  licenseFiles: [
    "third_party/licenses/BSD-2-Clause-Bitbook.txt",
    "third_party/licenses/BSD-2-Clause-fastcluster.txt",
    "third_party/licenses/MIT-node-addon-api.md",
  ],
  distribution: "public",
  transports: [{ kind: "vendored-source" }],
  buildTarget: {
    platform: "darwin",
    architecture: "arm64",
    napi: 8,
  },
});

export async function materializeClosedPilotNatives({ repositoryRoot }) {
  await assertNativePolicies(repositoryRoot);
  const outputPath = resolve(
    repositoryRoot,
    "dist/native/darwin-arm64/fbank.node",
  );
  const targetDirectory = dirname(outputPath);
  await assertReleaseTargetAbsent(targetDirectory);
  await mkdir(dirname(targetDirectory), { recursive: true });
  const temporaryDirectory = await mkdtemp(join(dirname(targetDirectory), ".darwin-arm64-release-"));
  try {
    const fbank = await buildReproducibleFbank({
      destinationPath: resolve(temporaryDirectory, "fbank.node"),
      expectedIdentity: pickIdentity(REBUILT_FBANK_MANIFEST),
      repositoryRoot,
    });
    const hcluster = await buildReproducibleHcluster({
      destinationPath: resolve(temporaryDirectory, "hcluster.node"),
      expectedIdentity: pickIdentity(HCLUSTER_MANIFEST),
      repositoryRoot,
    });
    await smokeReleaseNatives(temporaryDirectory);
    await publishReleaseDirectory(temporaryDirectory, targetDirectory);
    return {
      assets: [
        inventoryEntry(REBUILT_FBANK_MANIFEST, fbank),
        inventoryEntry(HCLUSTER_MANIFEST, hcluster),
      ],
    };
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

function inventoryEntry(asset, identity) {
  return {
    path: `dist/${asset.relativePath}`,
    byteLength: identity.byteLength,
    sha256: identity.sha256,
  };
}

async function publishReleaseDirectory(temporaryDirectory, targetDirectory) {
  try {
    await rename(temporaryDirectory, targetDirectory);
  } catch (cause) {
    throw new ClosedPilotNativeReleaseError(
      "RELEASE_OUTPUT_NOT_CLEAN",
      "closed-pilot native target changed before atomic publication",
      { cause },
    );
  }
}

async function smokeReleaseNatives(nativeDirectory) {
  const script = [
    "const f=require(process.argv[1]);",
    "const x=f.fbank(new Float32Array(16000));",
    "if(!(x.data instanceof Float32Array)||x.dims[1]!==80)process.exit(10);",
    "const h=require(process.argv[2]);",
    "const z=new Float32Array(256),o=Float32Array.from({length:256},()=>1);",
    "const y=new h.HCluster([z,o]).cluster({k:2});",
    "if(!Array.isArray(y.labels)||y.labels.length!==2)process.exit(11);",
  ].join("");
  const status = await runSmoke(script, [
    resolve(nativeDirectory, "fbank.node"),
    resolve(nativeDirectory, "hcluster.node"),
  ]);
  if (status !== 0) {
    throw new ClosedPilotNativeReleaseError(
      "RELEASE_BINARY_MISMATCH",
      "materialized native modules failed the Node 24 smoke probe",
    );
  }
}

function runSmoke(script, paths) {
  return new Promise((fulfill, reject) => {
    const child = spawn(process.execPath, ["-e", script, ...paths], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", reject);
    child.once("close", fulfill);
  });
}

async function assertReleaseTargetAbsent(targetDirectory) {
  try {
    await lstat(targetDirectory);
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return;
    throw new ClosedPilotNativeReleaseError(
      "RELEASE_OUTPUT_NOT_CLEAN",
      "cannot inspect closed-pilot native release target",
      { cause },
    );
  }
  throw new ClosedPilotNativeReleaseError(
    "RELEASE_OUTPUT_NOT_CLEAN",
    "dist/native/darwin-arm64 must not exist before materialization",
  );
}

function pickIdentity(asset) {
  return { byteLength: asset.byteLength, sha256: asset.sha256 };
}

async function assertNativePolicies(repositoryRoot) {
  const [manifest, supplyChain] = await Promise.all([
    readPolicyJson(resolve(repositoryRoot, "src/assets/manifest.json"), "fbank-native"),
    readPolicyJson(resolve(repositoryRoot, "src/assets/supply-chain.json"), "fbank-native"),
  ]);
  assertNativeInventoryPolicy(manifest);
  assertFbankPolicy(manifest, supplyChain);
  assertHclusterPolicy(manifest, supplyChain);
}

function assertNativeInventoryPolicy(manifest) {
  const actualIds = isRecord(manifest) && Array.isArray(manifest.assets)
    ? manifest.assets
      .filter((entry) => isRecord(entry) && entry.kind === "native")
      .map((entry) => entry.id)
      .sort()
    : [];
  const expectedIds = CLOSED_PILOT_NATIVE_ASSETS.map((asset) => asset.id).sort();
  if (!sameValue(actualIds, expectedIds)) {
    throw policyMismatch(undefined, "runtime manifest must contain exactly two native assets");
  }
}

function assertFbankPolicy(manifest, supplyChain) {
  const runtimeEntries = selectAssetEntries(manifest, "fbank-native");
  const supplyEntries = selectAssetEntries(supplyChain, "fbank-native");
  const runtime = runtimeEntries[0];
  const supply = supplyEntries[0];
  if (runtimeEntries.length !== 1 || !sameValue(runtime, REBUILT_FBANK_MANIFEST)) {
    throw policyMismatch("fbank-native", "runtime manifest does not pin authorized bytes");
  }
  if (supplyEntries.length !== 1 || !sameValue(projectFbankSupply(supply), REBUILT_FBANK_SUPPLY)) {
    throw policyMismatch("fbank-native", "supply-chain facts do not pin the source rebuild");
  }
}

function assertHclusterPolicy(manifest, supplyChain) {
  const runtimeEntries = selectAssetEntries(manifest, "hcluster-native");
  const supplyEntries = selectAssetEntries(supplyChain, "hcluster-native");
  const runtime = runtimeEntries[0];
  const supply = supplyEntries[0];
  if (runtimeEntries.length !== 1 || !sameValue(runtime, HCLUSTER_MANIFEST)) {
    throw policyMismatch("hcluster-native", "runtime manifest does not pin rebuilt bytes");
  }
  if (supplyEntries.length !== 1 || !sameValue(projectHclusterSupply(supply), HCLUSTER_SUPPLY)) {
    throw policyMismatch("hcluster-native", "supply-chain facts do not pin the clean rebuild");
  }
}

async function readPolicyJson(path, assetId) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new ClosedPilotNativeReleaseError(
      "RELEASE_POLICY_MISMATCH",
      `cannot read native release policy for ${assetId}`,
      { assetId, cause },
    );
  }
}

function selectAssetEntries(document, assetId) {
  if (!isRecord(document) || !Array.isArray(document.assets)) return [];
  return document.assets.filter((entry) => isRecord(entry) && entry.id === assetId);
}

function projectFbankSupply(value) {
  if (!isRecord(value)) return undefined;
  return {
    id: value.id,
    sourceMode: value.sourceMode,
    canonicalRepository: value.canonicalRepository,
    revision: value.revision,
    sourcePath: value.sourcePath,
    license: value.license,
    licenseFiles: value.licenseFiles,
    distribution: value.distribution,
    transports: value.transports,
    buildTarget: value.buildTarget,
  };
}

function projectHclusterSupply(value) {
  if (!isRecord(value)) return undefined;
  return {
    id: value.id,
    sourceMode: value.sourceMode,
    canonicalRepository: value.canonicalRepository,
    revision: value.revision,
    sourcePath: value.sourcePath,
    license: value.license,
    licenseFiles: value.licenseFiles,
    distribution: value.distribution,
    transports: value.transports,
    buildTarget: value.buildTarget,
  };
}

function policyMismatch(assetId, message) {
  return new ClosedPilotNativeReleaseError(
    "RELEASE_POLICY_MISMATCH",
    message,
    { assetId },
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value) {
  return value instanceof Error && "code" in value;
}

function sameValue(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}
