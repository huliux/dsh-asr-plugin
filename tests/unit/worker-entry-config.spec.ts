import { describe, expect, it } from "vitest";

import { parseWorkerEntryConfig } from "../../src/worker/entry-config.js";

describe("Worker entry configuration", () => {
  it("accepts exactly four absolute, bounded paths", () => {
    expect(parseWorkerEntryConfig([
      "/data/assets/model-fingerprint",
      "/plugin/dist",
      "/plugin/assets/manifest.json",
      "/meetings/id",
    ])).toEqual({
      modelRoot: "/data/assets/model-fingerprint",
      packagedNativeRoot: "/plugin/dist",
      manifestPath: "/plugin/assets/manifest.json",
      managedAudioDirectory: "/meetings/id",
    });
  });

  it.each([
    ["missing argument", ["/models", "/native", "/manifest"]],
    ["relative path", ["models", "/native", "/manifest", "/meeting"]],
    ["empty path", ["/models", "", "/manifest", "/meeting"]],
    ["oversized path", [`/${"x".repeat(4_096)}`, "/native", "/manifest", "/meeting"]],
  ])("rejects %s", (_label, args) => {
    expect(() => parseWorkerEntryConfig(args)).toThrow(expect.objectContaining({
      code: "INVALID_REQUEST",
    }));
  });
});
