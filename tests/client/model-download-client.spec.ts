import { expect, it, vi } from "vitest";
import { readDownloadStatus, saveDownloadSettings } from "../../src/client/model-download-client.js";

it("saves an independent HTTP proxy through DSH configuration with optimistic concurrency", async () => {
  const mutate = vi.fn(async () => true);
  expect(await saveDownloadSettings({ mutate } as never, "proxy", "http://localhost:7890", 6)).toBe("saved");
  expect(mutate).toHaveBeenCalledWith([
    { op: "set", path: ["hf_download_route"], value: "proxy" },
    { op: "set", path: ["hf_proxy_url"], value: "http://localhost:7890/" },
  ], 6);
});
it("rejects credential-bearing and unsupported proxies without persisting them", async () => {
  const mutate = vi.fn();
  for (const value of ["socks5://localhost:7890", "http://user:secret@localhost", "", "https://localhost/?key=secret"]) {
    expect(await saveDownloadSettings({ mutate } as never, "proxy", value, 1)).toBe("invalid");
  }
  expect(mutate).not.toHaveBeenCalled();
});
it("rejects malformed download progress rather than rendering it", async () => {
  const rpc = { call: vi.fn(async () => ({ ok: true, value: { phase: "downloading", downloadedBytes: -1 } })) };
  await expect(readDownloadStatus(rpc as never)).rejects.toThrow("INVALID_RESPONSE");
});

it("never stores proxy credentials even while selecting direct mode", async () => {
  const mutate = vi.fn();
  expect(await saveDownloadSettings({ mutate } as never, "direct", "http://user:secret@localhost:7890", 1)).toBe("invalid");
  expect(mutate).not.toHaveBeenCalled();
});

it("selects the default mirror without requiring a custom proxy address", async () => {
  const mutate = vi.fn(async () => true);
  expect(await saveDownloadSettings({ mutate } as never, "proxy", "", 3, "mirror")).toBe("saved");
  expect(mutate).toHaveBeenCalledWith([
    { op: "set", path: ["hf_download_route"], value: "proxy" },
    { op: "set", path: ["hf_proxy_url"], value: "" },
    { op: "set", path: ["hf_proxy_kind"], value: "mirror" },
  ], 3);
});
