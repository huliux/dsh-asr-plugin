import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";

import { readModelSettings } from "../../src/assets/model-settings.js";
import { resolveConfiguredRuntimeAssets } from "../../src/assets/runtime-assets.js";
import { acquireModelStageLease } from "../../src/assets/runtime-assets-stage-lease.js";
import { registerRecordingHostRpc, type RecordingRpcConnection } from "../../src/recording/host-rpc.js";
import {
  asrResult, createMeetingApplicationHarness, diarizationResult, immediateRunner,
} from "../helpers/meeting-application-fixture.js";
import { commitMeeting, meetingId } from "../helpers/meeting-repository-fixture.js";
import {
  cleanupRuntimeAssetsFixtures, createModelPackFixture, modelAsset, nativeAsset,
} from "../helpers/runtime-assets-fixture.js";

afterEach(cleanupRuntimeAssetsFixtures);

it.each(["runtime", "settings"] as const)("rejects already cancelled %s reads before acquiring a lease", async reader => {
  const fixture = await createModelPackFixture({ runtimeAssets: [modelAsset, nativeAsset], packAssets: [modelAsset] });
  const read = reader === "runtime" ? resolveConfiguredRuntimeAssets : readModelSettings;
  await expect(read({ ...fixture, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "STAGE_ABORTED" });
  const lease = await acquireModelStageLease(fixture.dataRoot);
  await lease[Symbol.asyncDispose]();
});

it.each(["runtime", "settings"] as const)("cancels %s reads while the installer still holds its lease", async reader => {
  const fixture = await createModelPackFixture({
    runtimeAssets: [modelAsset, nativeAsset], packAssets: [modelAsset],
  });
  const lease = await acquireModelStageLease(fixture.dataRoot);
  const controller = new AbortController();
  const read = reader === "runtime" ? resolveConfiguredRuntimeAssets : readModelSettings;
  const pending = read({ ...fixture, signal: controller.signal })
    .then(() => "resolved", error => error.code);
  try {
    expect(await Promise.race([pending, delay(100, "waiting")])).toBe("waiting");
    controller.abort();
    expect(await Promise.race([pending, delay(500, "still waiting")])).toBe("STAGE_ABORTED");
  } finally {
    await lease[Symbol.asyncDispose]();
    await pending;
  }
});

it.each(["import", "retranscription", "recording"] as const)(
  "cancels %s preparation without publishing a job or changing meetings", async action => {
    const fixture = await createModelPackFixture({ runtimeAssets: [modelAsset, nativeAsset], packAssets: [modelAsset] });
    const helper = { start: vi.fn(async () => { throw new Error("Unexpected capture"); }) };
    const worker = { start: vi.fn(async () => { throw new Error("Unexpected worker"); }) };
    const harness = await createMeetingApplicationHarness({
      recording: { helper, worker },
      prepareRuntime: async (signal?: AbortSignal) => {
        const assets = await resolveConfiguredRuntimeAssets({ ...fixture, ...(signal === undefined ? {} : { signal }) });
        return { engineFingerprint: assets.engineFingerprint, processingIdentity: assets.processing!.identity,
          asr: immediateRunner(asrResult()), diarization: immediateRunner(diarizationResult()) };
      },
    });
    commitMeeting(harness.repository, 1, { texts: ["Existing transcript"] });
    const before = harness.repository.getMeeting(meetingId(1));
    const lease = await acquireModelStageLease(fixture.dataRoot);
    const controller = new AbortController();
    const request = { signal: controller.signal };
    const pending = (action === "import" ? harness.application.startImport({ ...request, path: "/input.wav" })
      : action === "retranscription" ? harness.application.startRetranscription({ ...request, meetingId: meetingId(1), expectedVersion: 1 })
      : harness.application.controlRecording({ ...request, action: "start" }))
      .then(() => "published", error => error.code);
    try {
      expect(await Promise.race([pending, delay(100, "waiting")])).toBe("waiting");
      controller.abort();
      expect(await Promise.race([pending, delay(500, "still waiting")])).toBe("CANCELLED_BY_USER");
      expect(harness.context.jobs.list()).toEqual([]);
      expect(harness.audio.opened).toEqual([]);
      expect(harness.repository.getMeeting(meetingId(1))).toEqual(before);
      expect(helper.start).not.toHaveBeenCalled();
      expect(worker.start).not.toHaveBeenCalled();
    } finally {
      await lease[Symbol.asyncDispose]();
      await pending;
      await harness.dispose();
    }
  },
);

it("forwards model status RPC cancellation into the leased settings read", async () => {
  const fixture = await createModelPackFixture({ runtimeAssets: [modelAsset, nativeAsset], packAssets: [modelAsset] });
  const harness = await createMeetingApplicationHarness();
  let handler!: Parameters<RecordingRpcConnection["rpc"]["handle"]>[1];
  registerRecordingHostRpc({ rpc: { handle: (_channel, value) => {
    handler = value; return async () => {};
  } } }, harness.application, (signal?: AbortSignal) => readModelSettings({
    ...fixture, ...(signal === undefined ? {} : { signal }),
  }));
  const lease = await acquireModelStageLease(fixture.dataRoot);
  const controller = new AbortController();
  const pending = handler("models/status", {}, controller.signal);
  try {
    expect(await Promise.race([pending, delay(100, "waiting")])).toBe("waiting");
    controller.abort();
    expect(await Promise.race([pending, delay(500, "still waiting")]))
      .toMatchObject({ ok: false, error: { message: "STAGE_ABORTED" } });
  } finally {
    await lease[Symbol.asyncDispose]();
    await pending;
    await harness.dispose();
  }
});
