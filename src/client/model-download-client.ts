import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import { modelProxyUrl } from "../assets/model-download-contract.js";
import type { ModelDownloadPhase, ModelDownloadStatus } from "../assets/model-download-contract.js";
import { RECORDING_RPC_CHANNEL } from "../recording/rpc-contract.js";

export async function readDownloadStatus(rpc: ClientConnectionRpc, signal?: AbortSignal): Promise<ModelDownloadStatus> {
  const response = await rpc.call(RECORDING_RPC_CHANNEL, "models/download/status", {}, signal);
  if (!response.ok || typeof response.value !== "object" || response.value === null) throw new Error("INVALID_RESPONSE");
  const value = response.value as Record<string, unknown>;
  if (!["idle", "downloading", "verifying", "installing", "completed", "failed", "cancelled"].includes(String(value.phase)) ||
    (value.pack !== null && value.pack !== "base" && value.pack !== "punctuation") ||
    (value.jobId !== null && typeof value.jobId !== "string") ||
    (value.errorCode !== null && typeof value.errorCode !== "string") ||
    !Number.isSafeInteger(value.downloadedBytes) || !Number.isSafeInteger(value.totalBytes) ||
    Number(value.downloadedBytes) < 0 || Number(value.totalBytes) < Number(value.downloadedBytes)) throw new Error("INVALID_RESPONSE");
  return { phase: value.phase as ModelDownloadPhase, pack: value.pack as ModelDownloadStatus["pack"],
    downloadedBytes: Number(value.downloadedBytes), totalBytes: Number(value.totalBytes),
    jobId: value.jobId as string | null, errorCode: value.errorCode as string | null };
}
export async function saveDownloadSettings(form: ConfigPageForm, route: "direct" | "proxy", proxy: string, revision: number, kind?: "mirror" | "http") {
  let proxyUrl = proxy.trim();
  try { if ((route === "proxy" && kind !== "mirror") || proxyUrl !== "") proxyUrl = modelProxyUrl(proxyUrl); }
  catch { return "invalid" as const; }
  const changes = [{ op: "set" as const, path: ["hf_download_route"], value: route },
    { op: "set" as const, path: ["hf_proxy_url"], value: proxyUrl }];
  if (kind !== undefined) changes.push({ op: "set", path: ["hf_proxy_kind"], value: kind });
  return await form.mutate(changes, revision) ? "saved" as const : "conflict" as const;
}
