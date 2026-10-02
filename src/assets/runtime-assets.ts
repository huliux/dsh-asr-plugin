import { configuredProcessingMode, resolveProcessingAssets } from "./runtime-mode.js";
import type { ProcessingIdentity, ProcessingMode } from "./processing-identity.js";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  modelSetFingerprint,
  parseModelPackManifest,
} from "./model-pack.js";
import type { ModelPackManifest } from "./model-pack.js";
import { currentRuntime, inspectRegularFile, verifyAssetAtRoot } from "./runtime-asset-verifier.js";
import { doctorResolvedRuntimeAssets } from "./runtime-assets-doctor.js";
import type { DoctorReport } from "./runtime-assets-doctor.js";
import { RuntimeAssetsError } from "./runtime-assets-error.js";
import {
  installationState,
  installVerifiedModels,
  prepareModelStore,
  reconcileStaleStageEntries,
  verifyModelsAtRoot,
} from "./runtime-assets-installation.js";
import { acquireModelStageLease } from "./runtime-assets-stage-lease.js";
import { extractStrictTar } from "./strict-tar.js";
import type { ExpectedTarFile } from "./strict-tar.js";
import {
  AssetVerificationError,
  fingerprintAssetManifest,
  readAssetManifest,
} from "./verify-assets.js";
import type { AssetManifest } from "./verify-assets.js";

export type {
  DoctorCheck,
  DoctorHashStatus,
  DoctorIssue,
  DoctorReport,
} from "./runtime-assets-doctor.js";

export interface RuntimeAssetsInput {
  readonly mode?: ProcessingMode;
  readonly dataRoot: string;
  readonly packageRoot: string;
}

export interface StageModelPackInput extends RuntimeAssetsInput {
  readonly modelPackPath: string;
  readonly signal?: AbortSignal;
}

export interface StageResult {
  readonly installed: boolean;
  readonly modelSetFingerprint: string;
}

export interface ResolvedRuntimeAssets {
  readonly processing?: { readonly identity: ProcessingIdentity; readonly punctuationRoot: string | null };
  readonly engineFingerprint: string;
  readonly manifestPath: string;
  readonly modelRoot: string;
  readonly modelSetFingerprint: string;
  readonly packagedNativeRoot: string;
}

interface RuntimeLayout extends ResolvedRuntimeAssets {
  readonly manifest: AssetManifest;
  readonly modelStoreRoot: string;
}

function manifestPath(packageRoot: string): string {
  return join(resolve(packageRoot), "dist", "assets", "manifest.json");
}

function assertRuntimeAssetRoots(manifest: AssetManifest): void {
  for (const asset of manifest.assets) {
    const expectedPrefix = asset.kind === "native" ? "native/" : "models/";
    if (!asset.relativePath.startsWith(expectedPrefix)) {
      throw new AssetVerificationError(
        "MANIFEST_INVALID",
        `Asset is assigned to the wrong runtime root: ${asset.id}`,
        asset.id,
      );
    }
  }
}

async function runtimeLayout(input: RuntimeAssetsInput): Promise<RuntimeLayout> {
  const packagedRoot = join(resolve(input.packageRoot), "dist");
  const path = manifestPath(input.packageRoot);
  const [manifest, engineFingerprint] = await Promise.all([
    readAssetManifest(path),
    fingerprintAssetManifest(path),
  ]);
  assertRuntimeAssetRoots(manifest);
  const fingerprint = modelSetFingerprint(manifest);
  const modelStoreRoot = join(resolve(input.dataRoot), "assets");
  return {
    manifest,
    engineFingerprint,
    manifestPath: path,
    modelRoot: join(modelStoreRoot, fingerprint),
    modelSetFingerprint: fingerprint,
    modelStoreRoot,
    packagedNativeRoot: packagedRoot,
  };
}

function expectedPackFiles(manifest: ModelPackManifest): ExpectedTarFile[] {
  return [
    ...manifest.assets.map(({ byteLength, relativePath, sha256 }) => ({
      byteLength,
      install: true,
      relativePath,
      sha256,
    })),
    ...manifest.materials.map(({ byteLength, relativePath, sha256 }) => ({
      byteLength,
      install: false,
      relativePath,
      sha256,
    })),
  ];
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function collectThirdPartyFiles(
  packageRoot: string,
  relativeDirectory: string,
): Promise<string[]> {
  const directory = join(packageRoot, relativeDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => comparePaths(left.name, right.name))) {
    const path = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...await collectThirdPartyFiles(packageRoot, path));
    else if (entry.isFile()) files.push(path);
    else throw new RuntimeAssetsError("MODEL_PACK_INCOMPATIBLE", "Package legal material is invalid");
  }
  return files;
}

async function expectedLegalMaterials(packageRoot: string, split: boolean): Promise<ModelPackManifest["materials"]> {
  const paths = [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    ...await collectThirdPartyFiles(packageRoot, "third_party"),
    ...(split ? ["dist/assets/supply-chain.json"] : []),
  ];
  if (paths.length > 64) {
    throw new RuntimeAssetsError("MODEL_PACK_INCOMPATIBLE", "Package has too many legal files");
  }
  return Promise.all(paths.sort(comparePaths).map(async (relativePath) => ({
    relativePath,
    ...await inspectRegularFile(join(packageRoot, relativePath)),
  })));
}

async function assertLegalMaterials(
  packageRoot: string,
  actual: ModelPackManifest["materials"],
  split: boolean,
): Promise<void> {
  const expected = await expectedLegalMaterials(packageRoot, split);
  const sortedActual = [...actual]
    .sort((left, right) => comparePaths(left.relativePath, right.relativePath))
    .map(({ byteLength, relativePath, sha256 }) => ({ relativePath, byteLength, sha256 }));
  if (JSON.stringify(sortedActual) !== JSON.stringify(expected)) {
    throw new RuntimeAssetsError(
      "MODEL_PACK_INCOMPATIBLE",
      "Model pack legal material does not match the code package",
    );
  }
}

async function verifyRuntimeManifestAssets(layout: RuntimeLayout): Promise<void> {
  const runtime = currentRuntime();
  for (const asset of layout.manifest.assets) {
    const root = asset.kind === "native" ? layout.packagedNativeRoot : layout.modelRoot;
    await verifyAssetAtRoot(root, asset, runtime);
  }
}

function mapStageError(error: unknown): never {
  if (error instanceof RuntimeAssetsError || error instanceof AssetVerificationError) throw error;
  if (error instanceof Error && "code" in error && error.code === "ENOSPC") {
    throw new RuntimeAssetsError("DISK_SPACE_INSUFFICIENT", "Model pack staging needs more disk space");
  }
  if (error instanceof Error && "code" in error &&
    (error.code === "ELOOP" || error.code === "ENOENT")) {
    throw new RuntimeAssetsError("MODEL_PACK_INVALID", "Model pack file is invalid");
  }
  throw error;
}

async function validateModelPack(
  layout: RuntimeLayout,
  input: StageModelPackInput,
  destinationRoot?: string,
): Promise<ModelPackManifest> {
  let packManifest: ModelPackManifest | undefined;
  await extractStrictTar({
    archivePath: resolve(input.modelPackPath),
    onManifest(bytes) {
      packManifest = parseModelPackManifest(bytes, layout.manifest);
      return expectedPackFiles(packManifest);
    },
    ...(destinationRoot === undefined ? {} : { destinationRoot }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (packManifest === undefined) {
    throw new RuntimeAssetsError("MODEL_PACK_INCOMPATIBLE", "Model pack is incompatible");
  }
  await assertLegalMaterials(resolve(input.packageRoot), packManifest.materials,
    packManifest.schemaVersion === 2);
  return packManifest;
}

async function stageWhileLeased(
  layout: RuntimeLayout,
  input: StageModelPackInput,
): Promise<StageResult> {
  await prepareModelStore(layout);
  await reconcileStaleStageEntries(layout.modelStoreRoot);
  const pack = await validateModelPack(layout, input);
  const installation = { ...layout,
    manifest: { ...layout.manifest, assets: pack.assets },
    modelSetFingerprint: pack.modelSetFingerprint,
    modelRoot: join(layout.modelStoreRoot, pack.modelSetFingerprint),
  };
  const previousState = await installationState(installation);
  if (previousState === "ready") {
    return { installed: false, modelSetFingerprint: pack.modelSetFingerprint };
  }
  const temporaryRoot = await mkdtemp(join(layout.modelStoreRoot, `.stage-${randomUUID()}-`));
  await chmod(temporaryRoot, 0o700);
  try {
    const extracted = await validateModelPack(layout, input, temporaryRoot);
    if (JSON.stringify(extracted) !== JSON.stringify(pack)) {
      throw new RuntimeAssetsError("MODEL_PACK_INCOMPATIBLE", "Model pack changed during staging");
    }
    await verifyModelsAtRoot(installation.manifest, temporaryRoot, input.signal);
    const installed = await installVerifiedModels(installation, temporaryRoot, previousState);
    return { installed, modelSetFingerprint: pack.modelSetFingerprint };
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function stageModelPackUnchecked(input: StageModelPackInput): Promise<StageResult> {
  const layout = await runtimeLayout(input);
  const lease = await acquireModelStageLease(input.dataRoot, input.signal);
  try {
    return await stageWhileLeased(layout, input);
  } finally {
    await lease[Symbol.asyncDispose]();
  }
}

export async function stageModelPack(input: StageModelPackInput): Promise<StageResult> {
  try {
    return await stageModelPackUnchecked(input);
  } catch (error) {
    mapStageError(error);
  }
}

export async function resolveRuntimeAssets(
  input: RuntimeAssetsInput,
): Promise<ResolvedRuntimeAssets> {
  const layout = await runtimeLayout(input);
  if (input.mode !== undefined) return { ...layout, ...await resolveProcessingAssets(layout, input.mode) };
  await verifyRuntimeManifestAssets(layout);
  return {
    engineFingerprint: layout.engineFingerprint,
    manifestPath: layout.manifestPath,
    modelRoot: layout.modelRoot,
    modelSetFingerprint: layout.modelSetFingerprint,
    packagedNativeRoot: layout.packagedNativeRoot,
  };
}

export async function resolveConfiguredRuntimeAssets(
  input: RuntimeAssetsInput,
  punctuationEnabled?: boolean,
): Promise<ResolvedRuntimeAssets> {
  const layout = await runtimeLayout(input);
  const mode = await configuredProcessingMode(layout, punctuationEnabled);
  return { ...layout, ...await resolveProcessingAssets(layout, mode) };
}

export async function doctorRuntimeAssets(input: RuntimeAssetsInput): Promise<DoctorReport> {
  const layout = await runtimeLayout(input);
  return doctorResolvedRuntimeAssets(input, layout);
}

export {
  doctorRecordingHelper,
  packagedRecordingHelperLayout,
  verifyRecordingHelperAssets,
} from "./recording-helper-assets.js";
export type {
  RecordingHelperAssetsInput,
  RecordingHelperDoctorReport,
  RecordingHelperSignatureFacts,
  RecordingHelperSignatureInspectionInput,
  RecordingHelperSignatureInspector,
  VerifiedRecordingHelper,
} from "./recording-helper-assets.js";
