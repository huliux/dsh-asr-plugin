import { Context } from "@deepseek-ai/cordis";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";

import { RecordingPermissionsService } from "../../src/recording/permissions.js";
import { MEETING_ID, createMeetingApplicationHarness } from "../helpers/meeting-application-fixture.js";

const expected = process.env.DSH_RECORDING_PERMISSION_DENIAL;
it.skipIf(process.env.DSH_RECORDING_PERMISSION_GRANTED !== "1")("verifies granted permissions with the silent Helper probe", async () => {
  const context = new Context();
  const permissions = new RecordingPermissionsService({
    subprocess: new LocalSubprocessRuntime(context),
    resolveApp: async () => resolve("dist/recording-helper/DSHASRRecordingHelper.app"),
  });
  try {
    const status = await permissions.test();
    expect(status).toEqual({ microphone: "granted", system: "verified" });
  } finally { await context.fiber.dispose(); }
}, 60_000);

it.skipIf(expected === undefined)("blocks recording with the real revoked Helper permission", async () => {
  expect(["MICROPHONE_PERMISSION_REQUIRED", "SYSTEM_AUDIO_PERMISSION_REQUIRED"]).toContain(expected);
  const context = new Context();
  const runtime = new LocalSubprocessRuntime(context);
  const permissions = new RecordingPermissionsService({
    subprocess: runtime,
    resolveApp: async () => resolve("dist/recording-helper/DSHASRRecordingHelper.app"),
  });
  const capture = vi.fn(async () => { throw new Error("Capture must not start"); });
  const harness = await createMeetingApplicationHarness({ recording: {
    helper: { start: capture }, worker: { start: capture },
    checkPermissions: signal => permissions.require(signal),
  } });
  const jobStart = vi.spyOn(harness.context.jobs, "start");
  try {
    await expect(harness.application.controlRecording({ action: "start" }))
      .rejects.toMatchObject({ code: expected });
    expect(capture).not.toHaveBeenCalled();
    expect(jobStart).not.toHaveBeenCalled();
    expect(harness.application.getRecordingState()).toBeNull();
    expect(harness.repository.getMeeting(MEETING_ID)).toBeNull();
    await writeFile(resolve(`data/permission-gate-qualification/${expected}-gate.json`),
      JSON.stringify({ code: expected, captureStarted: false, jobCreated: false, meetingCreated: false }));
  } finally {
    await context.fiber.dispose();
    await harness.dispose();
  }
}, 60_000);
