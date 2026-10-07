import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { callRecordingRpc } from "../../src/client/recording-rpc-transport.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const failure = (endpoint: string, status: number) => new Error(`transport failure for /api/dsh-asr-recording/${endpoint}: HTTP ${status}`);
const fixture = () => { const call = vi.fn(); return { call, rpc: { call } as ClientConnectionRpc }; };
it.each(["state", "models/status", "models/download/status", "permissions/status"])("waits for a late %s route", async endpoint => {
  const { call, rpc } = fixture();
  call.mockRejectedValueOnce(failure(endpoint, 405)).mockResolvedValue({ ok: true, value: {} });
  const result = callRecordingRpc(rpc, endpoint, {});
  await vi.advanceTimersByTimeAsync(250);
  expect(await result).toEqual({ ok: true, value: {} });
  expect(call).toHaveBeenCalledTimes(2);
});
it.each([401, 403, 500])("does not retry HTTP %s", async status => {
  const { call, rpc } = fixture(); call.mockRejectedValue(failure("state", status));
  await expect(callRecordingRpc(rpc, "state", {})).rejects.toThrow(`HTTP ${status}`);
  expect(call).toHaveBeenCalledTimes(1);
});
it.each(["control", "models/download/start", "models/download/cancel", "permissions/test", "permissions/open-settings"])("never repeats %s", async endpoint => {
  const { call, rpc } = fixture(); call.mockRejectedValue(failure(endpoint, 404));
  await expect(callRecordingRpc(rpc, endpoint, {})).rejects.toThrow("HTTP 404");
  expect(call).toHaveBeenCalledTimes(1);
});
it("bounds retries to five seconds", async () => {
  const { call, rpc } = fixture(); call.mockRejectedValue(failure("state", 404));
  const assertion = expect(callRecordingRpc(rpc, "state", {})).rejects.toThrow("HTTP 404");
  await vi.advanceTimersByTimeAsync(5_000); await assertion;
  expect(call).toHaveBeenCalledTimes(21);
});
it("cancels the wait when the page is disposed", async () => {
  const { call, rpc } = fixture(); call.mockRejectedValue(failure("state", 404));
  const controller = new AbortController();
  const assertion = expect(callRecordingRpc(rpc, "state", {}, controller.signal)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(100); controller.abort(); await assertion;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(call).toHaveBeenCalledTimes(1);
});
it("preserves business failures without retries", async () => {
  const { call, rpc } = fixture(); call.mockResolvedValue({ ok: false, error: { message: "MODEL_NOT_READY" } });
  expect(await callRecordingRpc(rpc, "models/status", {})).toEqual({ ok: false, error: { message: "MODEL_NOT_READY" } });
  expect(call).toHaveBeenCalledTimes(1);
});
it("does not retry unrelated transport errors", async () => {
  const { call, rpc } = fixture(); call.mockRejectedValue(failure("permissions/status", 404));
  await expect(callRecordingRpc(rpc, "state", {})).rejects.toThrow("HTTP 404");
  expect(call).toHaveBeenCalledTimes(1);
});
it("does not read after cancellation", async () => {
  const { call, rpc } = fixture(); const controller = new AbortController(); controller.abort();
  await expect(callRecordingRpc(rpc, "state", {}, controller.signal)).rejects.toThrow();
  expect(call).not.toHaveBeenCalled();
});
