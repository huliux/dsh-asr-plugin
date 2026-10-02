import { expect, it, vi } from "vitest";
import { saveModelPreference } from "../../src/client/model-settings-client.js";

it("refuses enabling invalid punctuation without writing DSH configuration", async () => {
  const mutate = vi.fn();
  const rpc = { call: vi.fn(async () => ({ ok: true, value: {
    mode: "base", preference: null, inheritedLegacy: false, selectedReady: true,
    base: { state: "ready", issues: [] }, punctuation: { state: "invalid", issues: [] },
    native: { state: "ready", issues: [] }, dataDirectory: "/owned/data",
  } })) };
  expect(await saveModelPreference(rpc as never, { mutate } as never, true, 4)).toBe("not_ready");
  expect(mutate).not.toHaveBeenCalled();
});


it("saves a disabled preference with the captured DSH revision even when assets are missing", async () => {
  const mutate = vi.fn(async () => true);
  const rpc = { call: vi.fn() };
  expect(await saveModelPreference(rpc as never, { mutate } as never, false, 7)).toBe("saved");
  expect(rpc.call).not.toHaveBeenCalled();
  expect(mutate).toHaveBeenCalledWith([{ op: "set", path: ["punctuation_enabled"], value: false }], 7);
});

it("reports a refused DSH configuration write without claiming the mode changed", async () => {
  const mutate = vi.fn(async () => false);
  expect(await saveModelPreference({} as never, { mutate } as never, false, 2)).toBe("conflict");
});
