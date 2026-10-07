import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";

const READ_ENDPOINTS = new Set(["state", "models/status", "models/download/status", "permissions/status"]);
const RETRY_MS = 250;
const MAX_RETRIES = 20;

export async function callRecordingRpc(rpc: ClientConnectionRpc, endpoint: string,
  payload: unknown, signal?: AbortSignal) {
  const method = `dsh-asr-recording/${endpoint}`;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await rpc.call("/api", method, payload, signal); }
    catch (cause) {
      if (signal?.aborted || attempt >= MAX_RETRIES || !READ_ENDPOINTS.has(endpoint) ||
        !(cause instanceof Error) || ![404, 405].some(status =>
          cause.message === `transport failure for /api/${method}: HTTP ${status}`)) throw cause;
      await waitForRoute(signal);
    }
  }
}

function waitForRoute(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, RETRY_MS);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}
