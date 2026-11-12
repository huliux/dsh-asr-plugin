import { expect, it, vi } from "vitest";

import type { MeetingApplication } from "../../src/application/meeting-application.js";
import {
  registerRecordingHostRpc,
  type RecordingRpcConnection,
} from "../../src/recording/host-rpc.js";
import { RECORDING_RPC_CHANNEL } from "../../src/recording/rpc-contract.js";

it("只在 loopback UI channel 注册录音与 Meeting reference 四个 endpoint", async () => {
  let handler: Parameters<RecordingRpcConnection["rpc"]["handle"]>[1] | undefined;
  const remove = vi.fn(async () => undefined);
  const connection: RecordingRpcConnection = {
    rpc: {
      handle: vi.fn((_channel, value) => {
        handler = value;
        return remove;
      }),
    },
  };
  const state = { meetingId: "meeting-1", phase: "recording" };
  const application = {
    getRecordingState: vi.fn(() => state),
    hasRecordingHistory: vi.fn(() => true),
    getRecordingPreview: vi.fn(() => [{ seq: 1, text: "最近草稿" }]),
    controlRecording: vi.fn(async (input) => ({ action: input.action })),
    getMeetingReferenceCandidates: vi.fn(() => [{
      meetingId: "11111111-1111-4111-8111-111111111111",
      label: "产品周会",
      origin: "recording",
      phase: "recording",
      startedAtMs: null,
      createdAtMs: 1_788_220_800_000,
      recordingElapsedMs: null,
      durationMs: null,
    }]),
    resolveMeetingReference: vi.fn(() => ({
      meetingId: "11111111-1111-4111-8111-111111111111",
      label: "产品周会",
      origin: "recording",
      phase: "recording",
      startedAtMs: null,
      createdAtMs: 1_788_220_800_000,
      recordingElapsedMs: null,
      durationMs: null,
    })),
    getMeetingLivePage: vi.fn((input) => ({ meetingId: input.meetingId })),
  } as unknown as MeetingApplication;

  expect(registerRecordingHostRpc(connection, application)).toBe(remove);
  expect(connection.rpc.handle).toHaveBeenCalledWith(
    RECORDING_RPC_CHANNEL,
    expect.any(Function),
    { authority: "loopback" },
  );
  if (handler === undefined) throw new Error("RPC handler missing");
  const signal = new AbortController().signal;

  await expect(handler("state", {}, signal)).resolves.toEqual({
    ok: true,
    value: { recording: state, hasRecordingHistory: true, preview: [{ seq: 1, text: "最近草稿" }] },
  });
  await expect(handler("control", { action: "start", title: "周会" }, signal))
    .resolves.toMatchObject({ ok: true, value: { action: "start" } });
  expect(application.controlRecording).toHaveBeenCalledWith({ action: "start", title: "周会", signal });
  await expect(handler("live-page", { meeting_id: "meeting-1", limit: 3 }, signal))
    .resolves.toMatchObject({ ok: false, error: { code: "internal" } });
  expect(application.getMeetingLivePage).not.toHaveBeenCalled();
  await expect(handler("references/candidates", {
    session_id: "session-1",
    locale: "zh-CN",
    query: "产品",
  }, signal)).resolves.toEqual({
    ok: true,
    value: [{
      meeting_id: "11111111-1111-4111-8111-111111111111",
      label: "产品周会",
      origin: "recording",
      phase: "recording",
      started_at: null,
      created_at: "2026-09-01T00:00:00.000Z",
      recording_elapsed_ms: null,
      duration_ms: null,
    }],
  });
  expect(application.getMeetingReferenceCandidates).toHaveBeenCalledWith({
    locale: "zh-CN",
    query: "产品",
  });
  await expect(handler("references/resolve", {
    locale: "zh-CN",
    meeting_id: "11111111-1111-4111-8111-111111111111",
  }, signal)).resolves.toMatchObject({
    ok: true,
    value: { meeting_id: "11111111-1111-4111-8111-111111111111", label: "产品周会" },
  });
  expect(application.resolveMeetingReference).toHaveBeenCalledWith({
    locale: "zh-CN",
    meetingId: "11111111-1111-4111-8111-111111111111",
  });

  for (const [endpoint, payload] of [
    ["state", { unexpected: true }],
    ["control", { action: "stop" }],
    ["references/candidates", { session_id: "", locale: "zh-CN" }],
    ["references/resolve", { locale: "zh-CN" }],
    ["unknown", {}],
  ] as const) {
    await expect(handler(endpoint, payload, signal)).resolves.toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
  }
});

it("serves model status only through the existing loopback channel and rejects path overrides", async () => {
  let handler!: Parameters<RecordingRpcConnection["rpc"]["handle"]>[1];
  const status = { mode: "base", engine: "paraformer", preference: null, inheritedLegacy: false, selectedReady: false,
    base: { state: "missing", issues: [] }, parakeet: { state: "missing", issues: [] },
    punctuation: { state: "missing", issues: [] }, native: { state: "ready", issues: [] },
    dataDirectory: "/owned/data" } as const;
  const readStatus = vi.fn(async () => status);
  registerRecordingHostRpc({ rpc: { handle: (_channel, value) => {
    handler = value; return async () => {};
  } } }, {} as MeetingApplication, readStatus);
  const signal = new AbortController().signal;
  expect(await handler("models/status", {}, signal)).toEqual({ ok: true, value: status });
  expect(await handler("models/status", { data_dir: "/other" }, new AbortController().signal)).toMatchObject({ ok: false });
  expect(readStatus).toHaveBeenCalledOnce();
  expect(readStatus).toHaveBeenCalledWith(signal);
});

it("uses fixed pack requests and never accepts download paths, sources or proxy credentials in RPC", async () => {
  let handler!: Parameters<RecordingRpcConnection["rpc"]["handle"]>[1];
  const state = { pack: null, phase: "idle", downloadedBytes: 0, totalBytes: 0, jobId: null, errorCode: null } as const;
  const download = { status: () => state, start: vi.fn(async () => state), cancel: vi.fn(async () => state) };
  registerRecordingHostRpc({ rpc: { handle: (_channel, value) => {
    handler = value; return async () => {};
  } } }, {} as MeetingApplication, undefined, download);
  const signal = new AbortController().signal;
  expect(await handler("models/download/status", {}, signal)).toEqual({ ok: true, value: state });
  expect(await handler("models/download/start", { pack: "base" }, signal)).toEqual({ ok: true, value: state });
  expect(download.start).toHaveBeenCalledWith("base");
  expect(await handler("models/download/cancel", {}, signal)).toEqual({ ok: true, value: state });
  for (const payload of [{ pack: "all" }, { pack: "base", url: "https://example.com" },
    { pack: "base", proxyUrl: "http://secret@proxy" }, { pack: "punctuation", data_dir: "/other" }]) {
    expect(await handler("models/download/start", payload, signal)).toMatchObject({ ok: false });
  }
  expect(download.start).toHaveBeenCalledOnce();
});

it("serves permission diagnostics and accepts only the two fixed settings targets", async () => {
  let handler!: Parameters<RecordingRpcConnection["rpc"]["handle"]>[1];
  const permissions = {read: vi.fn(async () => ({microphone:"denied",system:"unverified"} as const)),
    test: vi.fn(async () => ({microphone:"granted",system:"verified"} as const)),
    require: vi.fn(async () => {}), openSettings: vi.fn(async () => {})};
  registerRecordingHostRpc({rpc:{handle:(_channel,value)=>{handler=value;return async()=>{};}}},
    {getRecordingState:()=>null} as unknown as MeetingApplication, undefined, undefined, permissions);
  const signal = new AbortController().signal;
  expect(await handler("permissions/status",{},signal)).toEqual({ok:true,value:{microphone:"denied",system:"unverified"}});
  expect(await handler("permissions/test",{},signal)).toEqual({ok:true,value:{microphone:"granted",system:"verified"}});
  for (const track of ["microphone","system"]) {
    expect(await handler("permissions/open-settings",{track},signal)).toEqual({ok:true,value:null});
  }
  for (const payload of [{track:"other"},{track:"system",url:"file:///private"}]) {
    expect(await handler("permissions/open-settings",payload,signal)).toMatchObject({ok:false});
  }
  expect(permissions.openSettings).toHaveBeenCalledTimes(2);
  expect(await handler("permissions/test",{path:"/other"},signal)).toMatchObject({ok:false});
});

it("does not play a diagnostic tone during an active recording", async () => {
  let handler!: Parameters<RecordingRpcConnection["rpc"]["handle"]>[1];
  const permissions = {read:vi.fn(),test:vi.fn(),require:vi.fn(),openSettings:vi.fn()};
  registerRecordingHostRpc({rpc:{handle:(_channel,value)=>{handler=value;return async()=>{};}}},
    {getRecordingState:()=>({phase:"recording"})} as unknown as MeetingApplication, undefined, undefined, permissions);
  expect(await handler("permissions/test",{},new AbortController().signal)).toMatchObject({
    ok:false,error:{message:"ENGINE_BUSY"},
  });
  expect(permissions.test).not.toHaveBeenCalled();
});

it("exports transcripts and picks folders without accepting destination file paths", async () => {
  let handler!: Parameters<RecordingRpcConnection["rpc"]["handle"]>[1];
  const control = {chooseDirectory: vi.fn(async () => "/Users/erwindassen/Transcripts"),
    exportTranscript: vi.fn(async () => ({bytes: 42, format: "md" as const,
      meetingId: "a4f7e766-928b-4a96-87d7-f81921fddd1c", outputPath: "/Users/erwindassen/Transcripts/call.md",
      segmentCount: 3, transcriptVersion: 1}))};
  registerRecordingHostRpc({rpc:{handle:(_channel,value)=>{handler=value;return async()=>{};}}},
    {getRecordingState:()=>null} as unknown as MeetingApplication, undefined, undefined, undefined, undefined, control);
  const signal = new AbortController().signal;
  expect(await handler("transcripts/choose-directory", {}, signal)).toEqual({ok:true,value:"/Users/erwindassen/Transcripts"});
  const payload = {destination:"default",format:"md",include_speakers:true,include_timestamps:true,
    meeting_id:"a4f7e766-928b-4a96-87d7-f81921fddd1c"};
  expect(await handler("transcripts/export", payload, signal)).toEqual({ok:true,value:{bytes:42,format:"md",
    meeting_id:"a4f7e766-928b-4a96-87d7-f81921fddd1c",output_path:"/Users/erwindassen/Transcripts/call.md",
    segment_count:3,transcript_version:1}});
  expect(control.exportTranscript).toHaveBeenCalledOnce();
  for (const invalid of [{...payload, output_path:"/tmp/injected.md"}, {...payload, format:"docx"},
    {...payload, meeting_id:"not-a-uuid"}, {...payload, directory:"relative/path"}]) {
    expect(await handler("transcripts/export", invalid, signal)).toMatchObject({ok:false});
  }
  expect(control.exportTranscript).toHaveBeenCalledOnce();
});

it("prepares recording models without accepting paths or recording audio", async () => {
  let handler!: Parameters<RecordingRpcConnection["rpc"]["handle"]>[1];
  const prepare = vi.fn(async () => undefined);
  const app = { getRecordingState: () => null } as unknown as MeetingApplication;
  registerRecordingHostRpc({ rpc: { handle: (_channel, value) => {
    handler = value; return async () => {};
  } } }, app, undefined, undefined, undefined, prepare);
  const signal = new AbortController().signal;
  expect(await handler("models/prepare", {}, signal)).toEqual({ ok: true, value: null });
  expect(await handler("models/prepare", { model_root: "/other" }, signal)).toMatchObject({ ok: false });
  expect(prepare).toHaveBeenCalledExactlyOnceWith(signal);
});

it("lists audio devices without accepting device paths or helper arguments", async () => {
  let handler!: Parameters<RecordingRpcConnection["rpc"]["handle"]>[1];
  const devices = { list: vi.fn(async () => ({
    defaultInputUID: "AppleUSBAudioEngine:Insta360:Insta360 Link 2C:144000:3",
    defaultOutputUID: null,
    devices: [{ uid: "AppleUSBAudioEngine:Insta360:Insta360 Link 2C:144000:3", name: "Insta360 Link 2C",
      inputChannels: 1, outputChannels: 0, defaultInput: true, defaultOutput: false }],
  })) };
  registerRecordingHostRpc({ rpc: { handle: (_channel, value) => {
    handler = value; return async () => {};
  } } }, { getRecordingState: () => null } as unknown as MeetingApplication,
  undefined, undefined, undefined, undefined, undefined, devices);
  const signal = new AbortController().signal;
  expect(await handler("devices/list", {}, signal)).toEqual({ ok: true, value: {
    default_input_uid: "AppleUSBAudioEngine:Insta360:Insta360 Link 2C:144000:3",
    default_output_uid: null,
    devices: [{ uid: "AppleUSBAudioEngine:Insta360:Insta360 Link 2C:144000:3", name: "Insta360 Link 2C",
      input_channels: 1, output_channels: 0, default_input: true, default_output: false }],
  } });
  expect(devices.list).toHaveBeenCalledExactlyOnceWith(signal);
  for (const payload of [{ uid: "BuiltInMicrophoneDevice" }, { argv: ["__devices"] }]) {
    expect(await handler("devices/list", payload, signal)).toMatchObject({ ok: false });
  }
  expect(devices.list).toHaveBeenCalledOnce();
});
