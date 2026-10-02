import { expect, it } from "vitest";

import { parseRecordingWorkerEntryConfig } from "../../src/recording/entry-config.js";

it("accepts only asset roots, allowed roots and fixed recording identities", () => {
  expect(parseRecordingWorkerEntryConfig([
    "/data/assets/model-fingerprint",
    "/plugin/dist",
    "/plugin/assets/manifest.json",
    "/data/meetings",
    "/data/work",
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "a".repeat(64),
  ])).toEqual({
    modelRoot: "/data/assets/model-fingerprint",
    packagedNativeRoot: "/plugin/dist",
    manifestPath: "/plugin/assets/manifest.json",
    meetingsRoot: "/data/meetings",
    workRoot: "/data/work",
    meetingId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    expectedFingerprint: "a".repeat(64),
  });
});
