import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import {
  currentRuntime,
  verifyAssetAtRoot,
} from "./runtime-asset-verifier.js";
import { readSupplyChainManifest, SupplyChainError } from "./supply-chain.js";
import type { SupplyChainDependency } from "./supply-chain.js";
import { AssetVerificationError } from "./verify-assets.js";
import { isPunctuationAsset, modelPackFingerprint } from "./model-pack.js";
import type { ModelPackKind } from "./model-pack.js";
import type { AssetManifest, AssetRecord, AssetRuntime } from "./verify-assets.js";

export type DoctorHashStatus =
  | "hash_mismatch"
  | "missing"
  | "not_checked"
  | "ok"
  | "size_mismatch";

export interface DoctorCheck {
  readonly hashStatus: DoctorHashStatus;
  readonly id: string;
  readonly kind: AssetRecord["kind"] | "dependency" | "package";
  readonly status: "error" | "ok";
  readonly version?: string;
}

export interface DoctorIssue {
  readonly action: "reinstall_dependency" | "reinstall_plugin" | "restage_model_pack" |
    "use_compatible_runtime";
  readonly code: string;
  readonly id: string;
}

export interface DoctorReport {
  readonly checks: DoctorCheck[];
  readonly engineFingerprint: string;
  readonly issues: DoctorIssue[];
  readonly modelSetFingerprint: string;
  readonly ready: boolean;
  readonly enhancedReady: boolean;
  readonly groups: Record<ModelPackKind | "native", DoctorGroup>;
  readonly runtime: AssetRuntime;
}

export interface DoctorGroup {
  readonly checks: DoctorCheck[];
  readonly issues: DoctorIssue[];
  ready: boolean;
}

export interface DoctorRuntimeLayout {
  readonly engineFingerprint: string;
  readonly manifest: AssetManifest;
  readonly manifestPath: string;
  readonly modelRoot: string;
  readonly modelSetFingerprint: string;
  readonly packagedNativeRoot: string;
}

function verificationHashStatus(error: AssetVerificationError): DoctorHashStatus {
  if (error.code === "ASSET_MISSING") return "missing";
  if (error.code === "ASSET_SIZE_MISMATCH") return "size_mismatch";
  if (error.code === "ASSET_HASH_MISMATCH") return "hash_mismatch";
  return "not_checked";
}

function recoveryAction(
  kind: AssetRecord["kind"] | "dependency",
  error: AssetVerificationError,
): DoctorIssue["action"] {
  if (error.code === "RUNTIME_MISMATCH") return "use_compatible_runtime";
  if (kind === "native") return "reinstall_plugin";
  if (kind === "dependency") return "reinstall_dependency";
  return "restage_model_pack";
}

async function doctorAsset(
  root: string,
  asset: AssetRecord,
  runtime: AssetRuntime,
): Promise<{ check: DoctorCheck; issue?: DoctorIssue }> {
  try {
    await verifyAssetAtRoot(root, asset, runtime);
    return { check: { id: asset.id, kind: asset.kind, status: "ok", hashStatus: "ok" } };
  } catch (error) {
    const verification = error instanceof AssetVerificationError
      ? error
      : new AssetVerificationError("ASSET_PATH_INVALID", "Runtime asset is invalid", asset.id);
    return {
      check: {
        id: asset.id,
        kind: asset.kind,
        status: "error",
        hashStatus: verificationHashStatus(verification),
      },
      issue: {
        id: asset.id,
        code: verification.code,
        action: recoveryAction(asset.kind, verification),
      },
    };
  }
}

function dependencyRuntimeMatches(
  dependency: SupplyChainDependency,
  runtime: AssetRuntime,
): boolean {
  return dependency.runtime.platform === runtime.platform &&
    dependency.runtime.architecture === runtime.architecture &&
    dependency.runtime.nodeMajor === runtime.nodeMajor &&
    dependency.runtime.verifiedNapi === runtime.napi &&
    dependency.runtime.addonNapi <= runtime.napi;
}

interface InstalledDependency {
  readonly root: string;
  readonly version: string;
}

async function readInstalledDependency(
  packageRoot: string,
  packageName: string,
): Promise<InstalledDependency | undefined> {
  const anchor = join(resolve(packageRoot), "package.json");
  const manifestPath = createRequire(anchor).resolve(`${packageName}/package.json`);
  const packageJson = await open(
    manifestPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const file = await packageJson.stat();
    if (!file.isFile() || file.size > 1024 * 1024) return undefined;
    const value = JSON.parse((await packageJson.readFile()).toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || !("name" in value) || !("version" in value) ||
      value.name !== packageName || typeof value.version !== "string") return undefined;
    return { root: dirname(manifestPath), version: value.version };
  } finally {
    await packageJson.close();
  }
}

function dependencyError(
  code: string,
  hashStatus: DoctorHashStatus,
): { check: DoctorCheck; issue: DoctorIssue } {
  return {
    check: { id: "onnxruntime-node", kind: "dependency", status: "error", hashStatus },
    issue: { id: "onnxruntime-node", code, action: code === "RUNTIME_MISMATCH"
      ? "use_compatible_runtime"
      : "reinstall_dependency" },
  };
}

async function doctorDependency(
  packageRoot: string,
  dependency: SupplyChainDependency,
  runtime: AssetRuntime,
): Promise<{ check: DoctorCheck; issue?: DoctorIssue }> {
  if (!dependencyRuntimeMatches(dependency, runtime)) {
    return dependencyError("RUNTIME_MISMATCH", "not_checked");
  }
  let installed: InstalledDependency | undefined;
  try {
    installed = await readInstalledDependency(packageRoot, dependency.packageName);
  } catch {
    return dependencyError("DEPENDENCY_MISSING", "missing");
  }
  if (installed?.version !== dependency.version) {
    return dependencyError("DEPENDENCY_VERSION_MISMATCH", "not_checked");
  }
  for (const artifact of dependency.artifacts) {
    const record: AssetRecord = {
      id: dependency.id,
      kind: "native",
      relativePath: artifact.path,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
    };
    try {
      await verifyAssetAtRoot(
        installed.root,
        record,
        runtime,
      );
    } catch (error) {
      const verification = error instanceof AssetVerificationError
        ? error
        : new AssetVerificationError("ASSET_PATH_INVALID", "Dependency artifact is invalid");
      return dependencyError(verification.code, verificationHashStatus(verification));
    }
  }
  return {
    check: {
      id: dependency.id,
      kind: "dependency",
      status: "ok",
      hashStatus: "ok",
      version: installed.version,
    },
  };
}

function supplyChainFailureReport(
  layout: DoctorRuntimeLayout,
  runtime: AssetRuntime,
  error: SupplyChainError,
): DoctorReport {
  return {
    ready: false,
    enhancedReady: false,
    groups: { base: { ready: false, checks: [], issues: [] },
      punctuation: { ready: false, checks: [], issues: [] },
      native: { ready: false, checks: [], issues: [] } },
    modelSetFingerprint: layout.modelSetFingerprint,
    engineFingerprint: layout.engineFingerprint,
    runtime,
    checks: [{
      id: "supply-chain-manifest",
      kind: "package",
      status: "error",
      hashStatus: "not_checked",
    }],
    issues: [{
      id: "supply-chain-manifest",
      code: error.code,
      action: "reinstall_plugin",
    }],
  };
}

async function modelGroupRoot(layout: DoctorRuntimeLayout, kind: ModelPackKind): Promise<string> {
  const splitRoot = join(dirname(layout.modelRoot), modelPackFingerprint(layout.manifest, kind));
  try {
    await lstat(splitRoot);
    return splitRoot;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return layout.modelRoot;
    }
    return splitRoot;
  }
}

async function doctorGroups(
  packageRoot: string,
  layout: DoctorRuntimeLayout,
  dependency: SupplyChainDependency,
  runtime: AssetRuntime,
): Promise<Record<ModelPackKind | "native", DoctorGroup>> {
  const groups = {
    base: { ready: true, checks: [], issues: [] } as DoctorGroup,
    punctuation: { ready: true, checks: [], issues: [] } as DoctorGroup,
    native: { ready: true, checks: [], issues: [] } as DoctorGroup,
  };
  const roots = { base: await modelGroupRoot(layout, "base"),
    punctuation: await modelGroupRoot(layout, "punctuation"), native: layout.packagedNativeRoot };
  for (const asset of layout.manifest.assets) {
    const kind = asset.kind === "native" ? "native" :
      isPunctuationAsset(asset) ? "punctuation" : "base";
    const result = await doctorAsset(roots[kind], asset, runtime);
    groups[kind].checks.push(result.check);
    if (result.issue !== undefined) groups[kind].issues.push(result.issue);
  }
  const result = await doctorDependency(packageRoot, dependency, runtime);
  groups.native.checks.push(result.check);
  if (result.issue !== undefined) groups.native.issues.push(result.issue);
  for (const group of Object.values(groups)) group.ready = group.issues.length === 0;
  return groups;
}

export async function doctorResolvedRuntimeAssets(
  input: { readonly packageRoot: string },
  layout: DoctorRuntimeLayout,
): Promise<DoctorReport> {
  const runtime = currentRuntime();
  let supplyChain;
  try {
    supplyChain = await readSupplyChainManifest({
      runtimeManifestPath: layout.manifestPath,
      supplyChainPath: join(resolve(input.packageRoot), "dist", "assets", "supply-chain.json"),
    });
  } catch (error) {
    if (!(error instanceof SupplyChainError)) throw error;
    return supplyChainFailureReport(layout, runtime, error);
  }
  const groups = await doctorGroups(input.packageRoot, layout, supplyChain.dependencies[0], runtime);
  const checks = [...groups.base.checks, ...groups.punctuation.checks, ...groups.native.checks];
  const issues = [...groups.base.issues, ...groups.native.issues];
  return {
    ready: issues.length === 0,
    enhancedReady: issues.length === 0 && groups.punctuation.ready,
    groups,
    modelSetFingerprint: layout.modelSetFingerprint,
    engineFingerprint: layout.engineFingerprint,
    runtime,
    checks,
    issues,
  };
}
