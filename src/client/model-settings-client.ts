import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import type { ModelGroupStatus, ModelSettingsStatus } from "../assets/model-settings-contract.js";
import { callRecordingRpc } from "./recording-rpc-transport.js";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_RESPONSE");
  return value as Record<string, unknown>;
}

function group(value: unknown): ModelGroupStatus {
  const item = record(value);
  if (!["ready", "missing", "invalid"].includes(String(item.state)) || !Array.isArray(item.issues)) {
    throw new Error("INVALID_RESPONSE");
  }
  const issues = item.issues.map((value: unknown) => {
    const issue = record(value);
    if (typeof issue.id !== "string" || typeof issue.code !== "string" || typeof issue.action !== "string") {
      throw new Error("INVALID_RESPONSE");
    }
    return { id: issue.id, code: issue.code, action: issue.action };
  });
  return { state: item.state as ModelGroupStatus["state"], issues };
}

export async function readModelStatus(rpc: ClientConnectionRpc, signal?: AbortSignal): Promise<ModelSettingsStatus> {
  const response = await callRecordingRpc(rpc, "models/status", {}, signal);
  if (!response.ok) throw new Error("MODEL_STATUS_FAILED");
  const item = record(response.value);
  if ((item.mode !== "base" && item.mode !== "enhanced") ||
    (item.preference !== null && typeof item.preference !== "boolean") ||
    typeof item.inheritedLegacy !== "boolean" || typeof item.selectedReady !== "boolean" ||
    typeof item.dataDirectory !== "string") throw new Error("INVALID_RESPONSE");
  return { mode: item.mode, preference: item.preference, inheritedLegacy: item.inheritedLegacy,
    selectedReady: item.selectedReady, dataDirectory: item.dataDirectory,
    base: group(item.base), punctuation: group(item.punctuation), native: group(item.native) };
}
