import { join, resolve } from "node:path";
import { doctorRuntimeAssets } from "./runtime-assets.js";
import type { RuntimeAssetsInput } from "./runtime-assets.js";
import { configuredProcessingMode } from "./runtime-mode.js";
import type { DoctorGroup } from "./runtime-assets-doctor.js";
import type { ModelGroupStatus, ModelSettingsStatus } from "./model-settings-contract.js";

function groupStatus(group: DoctorGroup): ModelGroupStatus {
  const allMissing = group.checks.length > 0 && group.checks.every(check => check.hashStatus === "missing");
  return { state: group.ready ? "ready" : allMissing ? "missing" : "invalid", issues: group.issues };
}

export async function readModelSettings(input: RuntimeAssetsInput, preference?: boolean): Promise<ModelSettingsStatus> {
  const report = await doctorRuntimeAssets(input);
  const mode = await configuredProcessingMode({
    modelRoot: join(resolve(input.dataRoot), "assets", report.modelSetFingerprint),
  }, preference);
  return {
    mode, preference: preference ?? null, inheritedLegacy: preference === undefined && mode === "enhanced",
    selectedReady: mode === "enhanced" ? report.enhancedReady : report.ready,
    base: groupStatus(report.groups.base), punctuation: groupStatus(report.groups.punctuation),
    native: groupStatus(report.groups.native), dataDirectory: resolve(input.dataRoot),
  };
}
