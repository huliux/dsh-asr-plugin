import { join, resolve } from "node:path";
import { doctorRuntimeAssets } from "./runtime-assets.js";
import type { RuntimeAssetsInput } from "./runtime-assets.js";
import { configuredProcessingMode } from "./runtime-mode.js";
import { acquireModelStageLease } from "./runtime-assets-stage-lease.js";
import { readAssetManifest } from "./verify-assets.js";
import type { DoctorGroup } from "./runtime-assets-doctor.js";
import type { ModelGroupStatus, ModelSettingsStatus } from "./model-settings-contract.js";

function groupStatus(group: DoctorGroup): ModelGroupStatus {
  const allMissing = group.checks.length > 0 && group.checks.every(check => check.hashStatus === "missing");
  return { state: group.ready ? "ready" : allMissing ? "missing" : "invalid", issues: group.issues };
}

async function readModelSettingsWhileLeased(input: RuntimeAssetsInput): Promise<ModelSettingsStatus> {
  const report = await doctorRuntimeAssets(input);
  const mode = await configuredProcessingMode({
    manifest: await readAssetManifest(join(resolve(input.packageRoot), "dist/assets/manifest.json")),
    modelRoot: join(resolve(input.dataRoot), "assets", report.modelSetFingerprint),
    modelStoreRoot: join(resolve(input.dataRoot), "assets"),
  });
  return {
    mode, preference: null, inheritedLegacy: false,
    selectedReady: mode === "enhanced" ? report.enhancedReady : report.ready,
    base: groupStatus(report.groups.base), punctuation: groupStatus(report.groups.punctuation),
    native: groupStatus(report.groups.native), dataDirectory: resolve(input.dataRoot),
  };
}

export async function readModelSettings(input: RuntimeAssetsInput, _legacyPreference?: boolean): Promise<ModelSettingsStatus> {
  const lease = await acquireModelStageLease(input.dataRoot, input.signal);
  try {
    return await readModelSettingsWhileLeased(input);
  } finally {
    await lease[Symbol.asyncDispose]();
  }
}
