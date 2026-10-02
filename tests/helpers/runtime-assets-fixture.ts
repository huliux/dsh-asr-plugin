import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

export const MODEL_BYTES = Buffer.from("model bytes");
export const MODEL_SET_FINGERPRINT =
  "ddc9cb78463f9cbd00a44d5feb30c5051fe93493fee52eddfc721c5684ecad17";
export const TWO_ASSET_FINGERPRINT =
  "0b22ec8adccbd48f01d86f9e9c52c72aa2afc5c3f4398602eaaf5c82742d4de4";

export interface FixtureAsset {
  byteLength: number;
  id: string;
  kind: "config" | "model" | "native" | "tokens";
  relativePath: string;
  runtime?: {
    architecture: string;
    napi: number;
    nodeMajor: number;
    platform: string;
  };
  sha256: string;
}

export const modelAsset = {
  id: "example-model",
  kind: "model",
  relativePath: "models/example.onnx",
  byteLength: 11,
  sha256: "9cb7487000bc86ac36ce83c4acfabe8878552be99572a6770f65ab1d048a5c48",
} as const;

export const configAsset = {
  id: "example-config",
  kind: "config",
  relativePath: "models/example.yaml",
  byteLength: 12,
  sha256: "fa7972d3a05c37631474cd92cbd08c3986a84b5db9e884b6fddfa8a2d41bae4d",
} as const;

export const nativeAsset: FixtureAsset = {
  id: "example-native",
  kind: "native",
  relativePath: "native/darwin-arm64/example.node",
  byteLength: 12,
  sha256: "b0ca94ca54cf33f214f3bf9f31dddf9438ae1a42a93cb493454f741a1e6f024e",
  runtime: { platform: "darwin", architecture: "arm64", nodeMajor: 24, napi: 10 },
};

function sourceFacts(id: string, closed = false): Record<string, unknown> {
  return {
    id,
    sourceMode: "reuse",
    canonicalRepository: "https://example.com/source",
    revision: "a".repeat(40),
    sourcePath: `${id}.bin`,
    license: closed ? "NOASSERTION" : "MIT",
    licenseFiles: closed ? [] : ["LICENSE"],
    attribution: "Test fixture",
    distribution: closed ? "closed-pilot-only" : "public",
    transports: closed
      ? [{ kind: "user-authorized-staging" }]
      : [{ kind: "canonical", url: "https://example.com/source.bin" }],
  };
}

export async function writeFixtureFile(
  root: string,
  path: string,
  bytes: string | Buffer,
): Promise<void> {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

export async function addDoctorRuntime(
  fixture: { packageRoot: string },
  options: { readonly pnpmSibling?: boolean } = {},
): Promise<void> {
  const dependencyRoot = options.pnpmSibling === true
    ? join(dirname(fixture.packageRoot), "node_modules")
    : join(fixture.packageRoot, "node_modules");
  await writeFixtureFile(
    fixture.packageRoot,
    "package.json",
    JSON.stringify({ name: "runtime-assets-doctor-fixture", private: true }),
  );
  await writeFixtureFile(
    fixture.packageRoot,
    nativeAsset.relativePath.replace(/^native\//u, "dist/native/"),
    "native bytes",
  );
  await writeFixtureFile(
    dependencyRoot,
    "onnxruntime-node/package.json",
    JSON.stringify({ name: "onnxruntime-node", version: "1.19.2" }),
  );
  await writeFixtureFile(
    dependencyRoot,
    "onnxruntime-node/bin/napi-v3/darwin/arm64/binding.node",
    "ort binding",
  );
  await writeFixtureFile(
    dependencyRoot,
    "onnxruntime-node/bin/napi-v3/darwin/arm64/runtime.dylib",
    "ort runtime",
  );
  await writeFixtureFile(
    fixture.packageRoot,
    "dist/assets/supply-chain.json",
    JSON.stringify(doctorSupplyChain()),
  );
}

function doctorSupplyChain(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    assets: [sourceFacts(modelAsset.id), sourceFacts(nativeAsset.id, true)],
    dependencies: [{
      ...sourceFacts("onnxruntime-node"),
      id: "onnxruntime-node",
      packageName: "onnxruntime-node",
      version: "1.19.2",
      integrity: `sha512-${"A".repeat(86)}==`,
      runtime: {
        platform: "darwin",
        architecture: "arm64",
        nodeMajor: 24,
        addonNapi: 3,
        verifiedNapi: 10,
      },
      artifacts: [
        {
          path: "bin/napi-v3/darwin/arm64/binding.node",
          byteLength: 11,
          sha256: "f96d732b2c65341fd28efad21953c3ed11876fdc047905159acbc59b2b5d4545",
        },
        {
          path: "bin/napi-v3/darwin/arm64/runtime.dylib",
          byteLength: 11,
          sha256: "1382c13df8f1cd41d9616a6574558cff1f9e5b0222a2597a6c755ad7a175b87f",
        },
      ],
      noticeFiles: [{
        path: "LICENSE",
        deliveryPath: "third_party/onnxruntime/LICENSE",
        byteLength: 1,
        sha256: "0".repeat(64),
      }],
    }],
  };
}

interface FixtureOptions {
  assetBytes?: Readonly<Record<string, Buffer>>;
  modelSetFingerprint?: string;
  packAssets?: ReadonlyArray<FixtureAsset>;
  runtimeAssets?: ReadonlyArray<FixtureAsset>;
}

export interface ModelPackFixture {
  archiveRoot: string;
  dataRoot: string;
  modelPackPath: string;
  packageRoot: string;
}

export async function writeModelPackArchive(
  archiveRoot: string,
  modelPackPath: string,
  assetPaths: readonly string[],
): Promise<void> {
  await execFile("/usr/bin/tar", [
    "--format=ustar",
    "-cf",
    modelPackPath,
    "-C",
    archiveRoot,
    "model-pack.json",
    ...assetPaths,
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ]);
}

export function updateTarChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
}

export function secondTarHeader(archive: Buffer): Buffer {
  const rawSize = archive.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
  const firstSize = Number.parseInt(rawSize, 8);
  const offset = 512 + Math.ceil(firstSize / 512) * 512;
  return archive.subarray(offset, offset + 512);
}

export function tarMemberSpan(header: Buffer): number {
  const rawSize = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
  return 512 + Math.ceil(Number.parseInt(rawSize, 8) / 512) * 512;
}

export function tarTerminatorOffset(archive: Buffer): number {
  let position = 0;
  while (!archive.subarray(position, position + 512).every((byte) => byte === 0)) {
    position += tarMemberSpan(archive.subarray(position, position + 512));
  }
  return position;
}

export async function createModelPackFixture(
  options: FixtureOptions = {},
): Promise<ModelPackFixture> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-runtime-assets-"));
  temporaryDirectories.push(root);
  const fixture = {
    archiveRoot: join(root, "archive"),
    dataRoot: join(root, "data"),
    modelPackPath: join(root, "model-pack.tar"),
    packageRoot: join(root, "package"),
  };
  const runtimeAssets = options.runtimeAssets ?? [modelAsset];
  const packAssets = options.packAssets ?? runtimeAssets;
  const assetBytes = options.assetBytes ?? { [modelAsset.relativePath]: MODEL_BYTES };
  await writeFixtureFile(
    fixture.packageRoot,
    "dist/assets/manifest.json",
    JSON.stringify({ schemaVersion: 2, algorithmRevision: "test-v1", assets: runtimeAssets }),
  );
  for (const [relativePath, bytes] of Object.entries(assetBytes)) {
    await writeFixtureFile(fixture.archiveRoot, relativePath, bytes);
  }
  await writeModelPackMaterials(fixture, packAssets, options.modelSetFingerprint);
  await writeModelPackArchive(
    fixture.archiveRoot,
    fixture.modelPackPath,
    packAssets.map(({ relativePath }) => relativePath),
  );
  return fixture;
}

async function writeModelPackMaterials(
  fixture: ModelPackFixture,
  packAssets: ReadonlyArray<FixtureAsset>,
  fingerprint = MODEL_SET_FINGERPRINT,
): Promise<void> {
  await writeFixtureFile(fixture.archiveRoot, "LICENSE", "license\n");
  await writeFixtureFile(fixture.archiveRoot, "THIRD_PARTY_NOTICES.md", "notices\n");
  await writeFixtureFile(fixture.packageRoot, "LICENSE", "license\n");
  await writeFixtureFile(fixture.packageRoot, "THIRD_PARTY_NOTICES.md", "notices\n");
  await writeFixtureFile(fixture.archiveRoot, "model-pack.json", JSON.stringify({
    schemaVersion: 1,
    modelSetFingerprint: fingerprint,
    assets: packAssets,
    materials: [
      {
        relativePath: "LICENSE",
        byteLength: 8,
        sha256: "c0c56958ef8be5c1979366896b7e0c7206949a5aa2b23f51429c7f56b10990d3",
      },
      {
        relativePath: "THIRD_PARTY_NOTICES.md",
        byteLength: 8,
        sha256: "cb58c31adbefea47f8c55d053b5e77302f4e8cd838db5715cea24e6a93f34c12",
      },
    ],
  }));
}

export async function cleanupRuntimeAssetsFixtures(): Promise<void> {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
}
