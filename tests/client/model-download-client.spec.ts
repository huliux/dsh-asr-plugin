import { expect, it, vi } from "vitest";
import { readDownloadStatus, saveDownloadSettings, startModelDownload } from "../../src/client/model-download-client.js";

it("saves an independent HTTP proxy through DSH configuration with optimistic concurrency", async () => {
  const mutate = vi.fn(async () => true);
  expect(await saveDownloadSettings({ mutate } as never, "default", "http://localhost:7890", 6, "http")).toBe("saved");
  expect(mutate).toHaveBeenCalledWith([
    { op: "set", path: ["hf_download_route"], value: "default" },
    { op: "set", path: ["hf_proxy_url"], value: "http://localhost:7890/" },
    { op: "set", path: ["hf_proxy_kind"], value: "http" },
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

it("restores default downloads by clearing the custom proxy address", async () => {
  const mutate = vi.fn(async () => true);
  expect(await saveDownloadSettings({ mutate } as never, "default", "", 3, "http")).toBe("saved");
  expect(mutate).toHaveBeenCalledWith([
    { op: "set", path: ["hf_download_route"], value: "default" },
    { op: "set", path: ["hf_proxy_url"], value: "" },
    { op: "set", path: ["hf_proxy_kind"], value: "http" },
  ], 3);
});

it("saves the default connection before starting a download without a separate save click", async () => {
  const events: string[] = [];
  const mutate = vi.fn(async () => { events.push("save"); return true; });
  const rpc = { call: vi.fn(async () => { events.push("download"); return { ok: true, value: {} }; }) };
  expect(await startModelDownload(rpc as never, { mutate } as never, "base", {
    route: "default", proxy: "", kind: "http", revision: 8,
  }, () => events.push("saved"))).toBe("started");
  expect(events).toEqual(["save", "saved", "download"]);
  expect(rpc.call).toHaveBeenCalledWith("/api", "dsh-asr-recording/models/download/start", { pack: "base" }, undefined);
});

it("does not download when saving the selected connection conflicts", async () => {
  const rpc = { call: vi.fn() };
  const mutate = vi.fn(async () => false);
  expect(await startModelDownload(rpc as never, { mutate } as never, "punctuation", {
    route: "default", proxy: "", kind: "http", revision: 8,
  })).toBe("conflict");
  expect(rpc.call).not.toHaveBeenCalled();
});
