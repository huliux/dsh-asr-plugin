import { describe, expect, it } from "vitest";

import { createPackagedWorkerLaunch } from "../../src/worker/launch.js";

describe("Packaged Worker launch", () => {
  it("只把 RuntimeAssets 解析出的双根和受管音频根传给 Worker", () => {
    const launch = createPackagedWorkerLaunch({
      kind: "asr",
      modelRoot: "/data/assets/model-fingerprint",
      packagedNativeRoot: "/plugin/dist",
      manifestPath: "/plugin/dist/assets/manifest.json",
      managedAudioDirectory: "/data/meetings",
      graceMs: 1_000,
    });

    expect(launch.argv.slice(-4)).toEqual([
      "/data/assets/model-fingerprint",
      "/plugin/dist",
      "/plugin/dist/assets/manifest.json",
      "/data/meetings",
    ]);
  });
});
