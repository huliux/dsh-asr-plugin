import { isPunctuationAsset } from "./model-pack.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface AssetRecord {
  kind: "config" | "model" | "native" | "tokens";
  id: string;
  relativePath: string;
  byteLength: number;
  sha256: string;
  runtime?: AssetRuntime;
}

export interface AssetManifest {
  algorithmRevision: string;
  schemaVersion: 2;
  assets: AssetRecord[];
}

export interface VerifyAssetsOptions {
  assetRoot: string;
  manifestPath: string;
  runtime?: AssetRuntime;
}

export interface VerifyAssetRootsOptions {
  readonly punctuationRoot?: string;
  assetIds: readonly string[];
  manifestPath: string;
  modelRoot: string;
  packagedNativeRoot: string;
  runtime?: AssetRuntime;
}

export interface AssetRuntime {
  platform: string;
  architecture: string;
  nodeMajor: number;
  napi: number;
}

export type AssetVerificationErrorCode =
  | "ASSET_HASH_MISMATCH"
  | "ASSET_MISSING"
  | "ASSET_PATH_INVALID"
  | "ASSET_SIZE_MISMATCH"
  | "MANIFEST_INVALID"
  | "RUNTIME_MISMATCH"
  | "STAGE_SOURCE_MISSING";

export class AssetVerificationError extends Error {
  readonly assetId: string | undefined;
  readonly code: AssetVerificationErrorCode;

  constructor(
    code: AssetVerificationErrorCode,
    message: string,
    assetId?: string,
  ) {
    super(message);
    this.name = "AssetVerificationError";
    this.code = code;
    this.assetId = assetId;
  }
}

export function mapAssetPathError(
  error: unknown,
  assetId: string,
): AssetVerificationError | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  if (error.code === "ENOENT") {
    return new AssetVerificationError("ASSET_MISSING", `Asset is missing: ${assetId}`, assetId);
  }
  if (["EACCES", "ELOOP", "ENAMETOOLONG", "ENOTDIR", "EPERM"].includes(String(error.code))) {
    return new AssetVerificationError(
      "ASSET_PATH_INVALID",
      `Asset path is not accessible: ${assetId}`,
      assetId,
    );
  }
  return undefined;
}

async function sha256Handle(
  handle: FileHandle,
  byteLength: number,
  assetId: string,
): Promise<string> {
  const hash = createHash("sha256");
  let position = 0;
  while (position < byteLength) {
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, byteLength - position));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) break;
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position !== byteLength) {
    throw new AssetVerificationError(
      "ASSET_SIZE_MISMATCH",
      `Asset changed during validation: ${assetId}`,
      assetId,
    );
  }
  return hash.digest("hex");
}

async function inspectAssetFile(filePath: string, assetId: string): Promise<{
  byteLength: number;
  sha256: string;
}> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const mapped = mapAssetPathError(error, assetId);
    if (mapped !== undefined) throw mapped;
    throw error;
  }
  try {
    const file = await handle.stat();
    if (!file.isFile()) {
      throw new AssetVerificationError(
        "ASSET_PATH_INVALID",
        `Asset path is not a regular file: ${assetId}`,
        assetId,
      );
    }
    return { byteLength: file.size, sha256: await sha256Handle(handle, file.size, assetId) };
  } finally {
    await handle.close();
  }
}

export function resolveAssetPath(assetRoot: string, asset: AssetRecord): string {
  const filePath = resolve(assetRoot, asset.relativePath);
  const pathFromRoot = relative(assetRoot, filePath);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new AssetVerificationError(
      "ASSET_PATH_INVALID",
      `Asset path escapes the asset root: ${asset.id}`,
      asset.id,
    );
  }
  return filePath;
}

async function assertRealDirectory(path: string, asset: AssetRecord): Promise<void> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    const mapped = mapAssetPathError(error, asset.id);
    if (mapped !== undefined) throw mapped;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new AssetVerificationError(
      "ASSET_PATH_INVALID",
      `Asset path contains an invalid directory: ${asset.id}`,
      asset.id,
    );
  }
}

export async function assertAssetPathDirectories(
  assetRoot: string,
  asset: AssetRecord,
): Promise<void> {
  const root = resolve(assetRoot);
  const filePath = resolveAssetPath(root, asset);
  const parentFromRoot = relative(root, dirname(filePath));
  let current = root;
  await assertRealDirectory(current, asset);
  for (const component of parentFromRoot === "" ? [] : parentFromRoot.split(sep)) {
    current = join(current, component);
    await assertRealDirectory(current, asset);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function invalidManifest(assetId?: string): never {
  throw new AssetVerificationError(
    "MANIFEST_INVALID",
    assetId ? `Invalid asset record: ${assetId}` : "Invalid asset manifest",
    assetId,
  );
}

function parseAsset(value: unknown): AssetRecord {
  if (!isRecord(value)) invalidManifest();
  const assetId = typeof value.id === "string" ? value.id : undefined;
  const kinds = new Set(["config", "model", "native", "tokens"]);
  const runtime = value.runtime;
  const validRuntime =
    isRecord(runtime) &&
    hasExactKeys(runtime, ["platform", "architecture", "nodeMajor", "napi"]) &&
    typeof runtime.platform === "string" &&
    runtime.platform.length > 0 &&
    typeof runtime.architecture === "string" &&
    runtime.architecture.length > 0 &&
    Number.isSafeInteger(runtime.nodeMajor) &&
    Number(runtime.nodeMajor) > 0 &&
    Number.isSafeInteger(runtime.napi) &&
    Number(runtime.napi) > 0;
  if (
    !hasExactKeys(
      value,
      ["id", "kind", "relativePath", "byteLength", "sha256"],
      ["runtime"],
    ) ||
    assetId === undefined ||
    !/^[a-z][a-z0-9._-]*$/.test(assetId) ||
    typeof value.relativePath !== "string" ||
    value.relativePath.length === 0 ||
    typeof value.kind !== "string" ||
    !kinds.has(value.kind) ||
    typeof value.byteLength !== "number" ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    (value.kind === "native" && !validRuntime) ||
    (runtime !== undefined && !validRuntime)
  ) {
    invalidManifest(assetId);
  }
  return value as unknown as AssetRecord;
}

function currentRuntime(): AssetRuntime {
  return {
    platform: process.platform,
    architecture: process.arch,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    napi: Number(process.versions.napi),
  };
}

function assertRuntime(asset: AssetRecord, actual: AssetRuntime): void {
  const expected = asset.runtime;
  if (
    expected !== undefined &&
    (expected.platform !== actual.platform ||
      expected.architecture !== actual.architecture ||
      expected.nodeMajor !== actual.nodeMajor ||
      expected.napi !== actual.napi)
  ) {
    throw new AssetVerificationError(
      "RUNTIME_MISMATCH",
      `Asset runtime mismatch: ${asset.id}`,
      asset.id,
    );
  }
}

function parseManifest(value: unknown): AssetManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "algorithmRevision", "assets"]) ||
    value.schemaVersion !== 2 ||
    typeof value.algorithmRevision !== "string" ||
    !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(value.algorithmRevision) ||
    !Array.isArray(value.assets)
  ) {
    invalidManifest();
  }
  const assets = value.assets.map(parseAsset);
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const asset of assets) {
    if (ids.has(asset.id) || paths.has(asset.relativePath)) {
      invalidManifest(asset.id);
    }
    ids.add(asset.id);
    paths.add(asset.relativePath);
  }
  return { algorithmRevision: value.algorithmRevision, schemaVersion: 2, assets };
}

export async function readAssetManifest(
  manifestPath: string,
): Promise<AssetManifest> {
  try {
    return parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  } catch (error) {
    if (error instanceof AssetVerificationError) throw error;
    invalidManifest();
  }
}

export async function fingerprintAssetManifest(manifestPath: string): Promise<string> {
  try {
    const bytes = await readFile(manifestPath);
    parseManifest(JSON.parse(bytes.toString("utf8")));
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if (error instanceof AssetVerificationError) throw error;
    invalidManifest();
  }
}

export async function verifyAssets(
  options: VerifyAssetsOptions,
): Promise<Record<string, string>> {
  const manifest = await readAssetManifest(options.manifestPath);
  return verifyManifestAssets(
    manifest,
    () => resolve(options.assetRoot),
    options.runtime ?? currentRuntime(),
  );
}

async function verifyManifestAssets(
  manifest: AssetManifest,
  rootFor: (asset: AssetRecord) => string,
  runtime: AssetRuntime,
): Promise<Record<string, string>> {
  const verified: Record<string, string> = {};
  for (const asset of manifest.assets) {
    assertRuntime(asset, runtime);
    const assetRoot = rootFor(asset);
    const filePath = resolveAssetPath(assetRoot, asset);
    await assertAssetPathDirectories(assetRoot, asset);
    const file = await inspectAssetFile(filePath, asset.id);
    if (file.byteLength !== asset.byteLength) {
      throw new AssetVerificationError(
        "ASSET_SIZE_MISMATCH",
        `Asset size mismatch: ${asset.id}`,
        asset.id,
      );
    }
    if (file.sha256 !== asset.sha256) {
      throw new AssetVerificationError(
        "ASSET_HASH_MISMATCH",
        `Asset hash mismatch: ${asset.id}`,
        asset.id,
      );
    }
    verified[asset.id] = filePath;
  }
  return verified;
}

export async function verifyAssetsAtRoots(
  options: VerifyAssetRootsOptions,
): Promise<Record<string, string>> {
  const manifest = await readAssetManifest(options.manifestPath);
  for (const asset of manifest.assets) {
    const prefix = asset.kind === "native" ? "native/" : "models/";
    if (!asset.relativePath.startsWith(prefix)) invalidManifest(asset.id);
  }
  const assetsById = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  const selectedAssets = options.assetIds.map((id) => {
    const asset = assetsById.get(id);
    if (asset === undefined) {
      throw new AssetVerificationError(
        "ASSET_MISSING",
        `Required asset is missing from the manifest: ${id}`,
        id,
      );
    }
    return asset;
  });
  const modelRoot = resolve(options.modelRoot);
  const packagedNativeRoot = resolve(options.packagedNativeRoot);
  return verifyManifestAssets(
    { ...manifest, assets: selectedAssets },
    (asset) => asset.kind === "native" ? packagedNativeRoot
      : isPunctuationAsset(asset) && options.punctuationRoot !== undefined
        ? resolve(options.punctuationRoot) : modelRoot,
    options.runtime ?? currentRuntime(),
  );
}
