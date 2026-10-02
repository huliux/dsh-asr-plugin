import { expect, it } from "vitest";

import { createPackagedRecordingWorkerLaunch } from "../../src/recording/launch.js";

it("constructs the recording entry path from fixed roots and identities", () => {
  const launch = createPackagedRecordingWorkerLaunch({
    modelRoot: "/data/assets/model-fingerprint",
    packagedNativeRoot: "/plugin/dist",
    manifestPath: "/plugin/dist/assets/manifest.json",
    meetingsRoot: "/data/meetings",
    workRoot: "/data/work",
    meetingId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    expectedFingerprint: "a".repeat(64),
    graceMs: 2_000,
  });

  expect(launch.argv[0]).toBe(process.execPath);
  expect(launch.argv[1]).toMatch(/recording-entry\.js$/);
  expect(launch.argv.slice(2)).toEqual([
    "/data/assets/model-fingerprint",
    "/plugin/dist",
    "/plugin/dist/assets/manifest.json",
    "/data/meetings",
    "/data/work",
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "a".repeat(64),
  ]);
  expect(launch.cwd).toMatch(/\/recording$/);
});
