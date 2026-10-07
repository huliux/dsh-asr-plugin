import { expect, it, vi } from "vitest";
import { readModelStatus } from "../../src/client/model-settings-client.js";

const ready = { state: "ready", issues: [] };
const status = { mode: "enhanced", preference: null, inheritedLegacy: false,
  selectedReady: true, base: ready, punctuation: ready, native: ready, dataDirectory: "/owned/data" };

it("reads automatic punctuation status without a configuration write", async () => {
  const rpc = { call: vi.fn(async () => ({ ok: true, value: status })) };
  expect(await readModelStatus(rpc as never)).toEqual(status);
  expect(rpc.call).toHaveBeenCalledWith("/api", "dsh-asr-recording/models/status", {}, undefined);
});

it("preserves grouped repair details without treating damaged punctuation as ready", async () => {
  const damaged = { ...status, selectedReady: false, punctuation: { state: "invalid",
    issues: [{ id: "punc-model", code: "ASSET_MISMATCH", action: "restage" }] } };
  const rpc = { call: vi.fn(async () => ({ ok: true, value: damaged })) };
  expect(await readModelStatus(rpc as never)).toEqual(damaged);
});

it("rejects invalid mode responses", async () => {
  const rpc = { call: vi.fn(async () => ({ ok: true, value: { ...status, mode: "unknown" } })) };
  await expect(readModelStatus(rpc as never)).rejects.toThrow("INVALID_RESPONSE");
});
