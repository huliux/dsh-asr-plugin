import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { currentRuntime, verifyAssetAtRoot } from "./runtime-asset-verifier.js";
import { RuntimeAssetsError } from "./runtime-assets-error.js";
import { AssetVerificationError } from "./verify-assets.js";
import type { AssetManifest } from "./verify-assets.js";

export interface ModelInstallationLayout {
  readonly manifest: AssetManifest;
  readonly modelRoot: string;
  readonly modelStoreRoot: string;
}

export type InstallationState = "absent" | "damaged" | "ready";

const STALE_STAGE_ENTRY =
  /^\.stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[A-Za-z0-9]{6}$/u;
const STALE_DAMAGED_ENTRY =
  /^\.damaged-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export async function verifyModelsAtRoot(
  manifest: AssetManifest,
  modelRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  const runtime = currentRuntime();
  for (const asset of manifest.assets) {
    if (signal?.aborted === true) {
      throw new RuntimeAssetsError("STAGE_ABORTED", "Model pack staging was cancelled");
    }
    if (asset.kind !== "native") await verifyAssetAtRoot(modelRoot, asset, runtime, signal);
  }
  if (signal?.aborted === true) {
    throw new RuntimeAssetsError("STAGE_ABORTED", "Model pack staging was cancelled");
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function installationState(
  layout: Pick<ModelInstallationLayout, "manifest" | "modelRoot">,
  signal?: AbortSignal,
): Promise<InstallationState> {
  try {
    const existing = await lstat(layout.modelRoot);
    if (!existing.isDirectory() || existing.isSymbolicLink()) return "damaged";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "absent";
    throw error;
  }
  try {
    await verifyModelsAtRoot(layout.manifest, layout.modelRoot, signal);
    return "ready";
  } catch (error) {
    if (error instanceof RuntimeAssetsError && error.code === "STAGE_ABORTED") throw error;
    if (error instanceof AssetVerificationError || error instanceof RuntimeAssetsError) {
      return "damaged";
    }
    throw error;
  }
}

async function installWhenAbsent(
  layout: ModelInstallationLayout,
  temporaryRoot: string,
): Promise<boolean> {
  try {
    await rename(temporaryRoot, layout.modelRoot);
  } catch (error) {
    if (targetAlreadyExists(error) && await installationState(layout) === "ready") return false;
    throw error;
  }
  await fsyncDirectory(layout.modelStoreRoot);
  return true;
}

function targetAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

async function discardDisplaced(
  layout: ModelInstallationLayout,
  displacedRoot: string,
): Promise<void> {
  await rm(displacedRoot, { force: true, recursive: true });
  await fsyncDirectory(layout.modelStoreRoot);
}

async function restoreIfReady(
  layout: ModelInstallationLayout,
  displacedRoot: string,
): Promise<boolean> {
  try {
    await verifyModelsAtRoot(layout.manifest, displacedRoot);
  } catch (error) {
    if (error instanceof AssetVerificationError || error instanceof RuntimeAssetsError) return false;
    throw error;
  }
  try {
    await rename(displacedRoot, layout.modelRoot);
    await fsyncDirectory(layout.modelStoreRoot);
  } catch (error) {
    if (!targetAlreadyExists(error) || await installationState(layout) !== "ready") throw error;
    await discardDisplaced(layout, displacedRoot);
  }
  return true;
}

async function replaceDamagedInstallation(
  layout: ModelInstallationLayout,
  temporaryRoot: string,
): Promise<boolean> {
  const displacedRoot = join(layout.modelStoreRoot, `.damaged-${randomUUID()}`);
  try {
    await rename(layout.modelRoot, displacedRoot);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return installWhenAbsent(layout, temporaryRoot);
    }
    throw error;
  }
  if (await restoreIfReady(layout, displacedRoot)) return false;
  try {
    await rename(temporaryRoot, layout.modelRoot);
    await fsyncDirectory(layout.modelStoreRoot);
  } catch (error) {
    if (targetAlreadyExists(error) && await installationState(layout) === "ready") {
      await discardDisplaced(layout, displacedRoot);
      return false;
    }
    try { await rename(displacedRoot, layout.modelRoot); } catch {
      // Retain displaced data if rollback loses a race with a valid installation.
    }
    throw error;
  }
  await discardDisplaced(layout, displacedRoot);
  return true;
}

export async function installVerifiedModels(
  layout: ModelInstallationLayout,
  temporaryRoot: string,
  previousState: InstallationState,
): Promise<boolean> {
  if (previousState === "absent") return installWhenAbsent(layout, temporaryRoot);
  const latestState = await installationState(layout);
  if (latestState === "ready") return false;
  if (latestState === "absent") return installWhenAbsent(layout, temporaryRoot);
  return replaceDamagedInstallation(layout, temporaryRoot);
}

export async function prepareModelStore(layout: ModelInstallationLayout): Promise<void> {
  await mkdir(layout.modelStoreRoot, { recursive: true, mode: 0o700 });
  const modelStore = await lstat(layout.modelStoreRoot);
  if (modelStore.isSymbolicLink() || !modelStore.isDirectory()) {
    throw new RuntimeAssetsError("MODEL_NOT_READY", "Model store root is invalid");
  }
  await chmod(layout.modelStoreRoot, 0o700);
}

function isStaleStageEntry(name: string): boolean {
  return STALE_STAGE_ENTRY.test(name) || STALE_DAMAGED_ENTRY.test(name);
}

export async function reconcileStaleStageEntries(modelStoreRoot: string): Promise<void> {
  const entries = await readdir(modelStoreRoot, { withFileTypes: true });
  const stale = entries.filter(({ name }) => isStaleStageEntry(name));
  for (const entry of stale) {
    await rm(join(modelStoreRoot, entry.name), { force: true, recursive: true });
  }
  if (stale.length > 0) await fsyncDirectory(modelStoreRoot);
}
