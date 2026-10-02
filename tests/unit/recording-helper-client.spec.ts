import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import { afterEach, expect, it, vi } from "vitest";

import {
  RecordingHelperClient,
  type RecordingHelperSubprocess,
} from "../../src/recording/helper-client.js";
import type { RecordingAudioLayout } from "../../src/storage/managed-audio-store.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

class FakeHandle implements SubprocessHandle {
  readonly control = undefined;
  readonly pid = 42;
  readonly stdin = undefined;
  readonly stdout = undefined;
  readonly stderr = undefined;
  readonly collected = {};
  readonly outcome = Promise.withResolvers<SubprocessOutcome>();
  readonly done = this.outcome.promise;
  readonly terminate = vi.fn(() => this.outcome.resolve({ exitCode: null, signal: "SIGTERM" }));

  async waitForExit(): Promise<boolean> {
    await this.done;
    return true;
  }
}

async function fixture(readyTimeoutMs = 2_000, terminationTimeoutMs = 2_000) {
  const root = await mkdtemp(join(tmpdir(), "recording-helper-client-"));
  roots.push(root);
  const sessionRoot = join(root, "meetings", MEETING_ID);
  const layout: RecordingAudioLayout = {
    meetingDirectory: sessionRoot,
    recordingDirectory: join(sessionRoot, "recording"),
    workRecordingDirectory: join(root, "work", MEETING_ID, "recording"),
  };
  await mkdir(layout.recordingDirectory, { recursive: true, mode: 0o700 });
  await mkdir(layout.workRecordingDirectory, { recursive: true, mode: 0o700 });
  const handle = new FakeHandle();
  let spawnSpec: SubprocessSpawnSpec | undefined;
  const subprocess: RecordingHelperSubprocess = {
    spawn(spec) {
      spawnSpec = spec;
      return handle;
    },
  };
  const client = new RecordingHelperClient({
    appRoot: "/plugin/dist/recording-helper/DSHASRRecordingHelper.app",
    commandTimeoutMs: 2_000,
    hostProcessId: 777,
    readyTimeoutMs,
    subprocess,
    terminationTimeoutMs,
  });
  return { client, handle, layout, sessionRoot, spawnSpec: () => spawnSpec };
}

async function event(sessionRoot: string, seq: number, value: Record<string, unknown>) {
  const root = join(sessionRoot, "control", "events");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `.${seq}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify({
    schema_version: 1,
    event_seq: seq,
    ...value,
  })}\n`, { mode: 0o600 });
  await rename(temporary, join(root, `${seq}.json`));
}

function track(state: "off" | "starting" | "on" | "failed", requested = true) {
  return { state, requested, error_code: null };
}

async function ready(value: Awaited<ReturnType<typeof fixture>>) {
  const control = join(value.sessionRoot, "control");
  await mkdir(control, { recursive: true, mode: 0o700 });
  await writeFile(join(control, "capture-pids.json"), JSON.stringify({ schema_version: 1, tracks: {} }),
    { mode: 0o600 });
  const pending = value.client.start({
    layout: value.layout,
    meetingId: MEETING_ID,
    signal: new AbortController().signal,
  });
  await vi.waitFor(() => expect(value.spawnSpec()).toBeDefined());
  await event(value.sessionRoot, 1, {
    type: "helper_ready",
    meeting_id: MEETING_ID,
    tracks: { mic: track("starting"), system: track("starting") },
  });
  await event(value.sessionRoot, 2, {
    type: "track_state",
    track: "mic",
    ...track("on"),
  });
  return pending;
}

it("launches the signed app through open and follows command acknowledgements", async () => {
  const value = await fixture();
  const session = await ready(value);

  expect(value.spawnSpec()).toMatchObject({
    argv: [
      "/usr/bin/open",
      "-n",
      "-W",
      "/plugin/dist/recording-helper/DSHASRRecordingHelper.app",
      "--args",
      value.sessionRoot,
      MEETING_ID,
      "777",
    ],
    cwd: "/plugin/dist/recording-helper",
    stdio: { stdin: "ignore" },
  });
  expect(session.snapshot()).toMatchObject({
    mic: { requested: true, state: "on" },
    system: { requested: true, state: "starting" },
  });

  const toggled = session.setTrack("mic", false);
  const command = join(value.sessionRoot, "control", "commands", "1.json");
  await vi.waitFor(async () => expect(JSON.parse(await readFile(command, "utf8"))).toEqual({
    schema_version: 1,
    command_id: 1,
    action: "mic_off",
  }));
  await event(value.sessionRoot, 3, {
    type: "track_state",
    track: "mic",
    ...track("off", false),
  });
  await event(value.sessionRoot, 4, {
    type: "command_applied",
    command_id: 1,
    result: "ok",
    error_code: null,
    tracks: { mic: track("off", false), system: track("starting") },
  });
  await expect(toggled).resolves.toMatchObject({ mic: { requested: false, state: "off" } });

  const stopped = session.stop();
  const stopCommand = join(value.sessionRoot, "control", "commands", "2.json");
  await vi.waitFor(async () => expect(JSON.parse(await readFile(stopCommand, "utf8")))
    .toMatchObject({ command_id: 2, action: "stop" }));
  await event(value.sessionRoot, 5, {
    type: "chunk_closed",
    track: "system",
    start_us: 1_788_080_000_000_000,
    end_us: 1_788_080_012_000_000,
    frame_count: 192_000,
  });
  await event(value.sessionRoot, 6, {
    type: "command_applied",
    command_id: 2,
    result: "ok",
    error_code: null,
    tracks: { mic: track("off", false), system: track("off", false) },
  });
  await event(value.sessionRoot, 7, { type: "helper_stopped", reason: "command" });
  value.handle.outcome.resolve({ exitCode: 0, signal: null });

  await expect(stopped).resolves.toMatchObject({
    captureEndUs: 1_788_080_012_000_000,
    mic: { state: "off" },
    system: { state: "off" },
  });
});

it("fails closed on an event with unknown fields", async () => {
  const value = await fixture();
  const pending = value.client.start({
    layout: value.layout,
    meetingId: MEETING_ID,
    signal: new AbortController().signal,
  });
  await vi.waitFor(() => expect(value.spawnSpec()).toBeDefined());
  await event(value.sessionRoot, 1, {
    type: "helper_ready",
    meeting_id: MEETING_ID,
    tracks: { mic: track("on"), system: track("on") },
    unexpected: true,
  });

  const rejected = expect(pending).rejects.toMatchObject({ code: "HELPER_PROTOCOL_ERROR" });
  await cancellationAcknowledgement(value);
  await rejected;
  expect(value.handle.terminate).not.toHaveBeenCalled();
});

async function cancellationAcknowledgement(value: Awaited<ReturnType<typeof fixture>>) {
  const control = join(value.sessionRoot, "control");
  await vi.waitFor(async () => expect(JSON.parse(await readFile(join(control, "host-cancel.json"), "utf8")))
    .toEqual({ schema_version: 1, cancel: true }));
  expect(value.handle.terminate).not.toHaveBeenCalled();
  await writeFile(join(control, "host-cancelled.json"), JSON.stringify({
    schema_version: 1, cancelled: true,
  }), { mode: 0o600 });
  value.handle.outcome.resolve({ exitCode: 0, signal: null });
}

it("waits for detached Helper cleanup before rejecting a startup timeout", async () => {
  const value = await fixture(50);
  const pending = value.client.start({ layout: value.layout, meetingId: MEETING_ID,
    signal: new AbortController().signal });
  const rejected = expect(pending).rejects.toMatchObject({ code: "HELPER_READY_TIMEOUT" });
  await cancellationAcknowledgement(value);
  await rejected;
  expect(value.handle.terminate).not.toHaveBeenCalled();
});

it("waits for detached cleanup when startup is cancelled by the caller", async () => {
  const value = await fixture();
  const abort = new AbortController();
  const pending = value.client.start({ layout: value.layout, meetingId: MEETING_ID, signal: abort.signal });
  const rejected = expect(pending).rejects.toMatchObject({ code: "CANCELLED_BY_USER" });
  await vi.waitFor(() => expect(value.spawnSpec()).toBeDefined());
  abort.abort();
  await cancellationAcknowledgement(value);
  await rejected;
});

it("does not accept launcher exit as capture cleanup after native initialization", async () => {
  const value = await fixture(50, 80);
  const control = join(value.sessionRoot, "control");
  await mkdir(control, { recursive: true, mode: 0o700 });
  await writeFile(join(control, "capture-pids.json"), JSON.stringify({ schema_version: 1, tracks: {} }),
    { mode: 0o600 });
  const pending = value.client.start({ layout: value.layout, meetingId: MEETING_ID,
    signal: new AbortController().signal });
  const rejected = expect(pending).rejects.toMatchObject({ code: "HELPER_TERMINATION_TIMEOUT" });
  value.handle.outcome.resolve({ exitCode: 0, signal: null });
  await rejected;
});

it("does not accept launcher exit before detached App initialization as cleanup", async () => {
  const value = await fixture(50);
  let settled = false;
  const pending = value.client.start({ layout: value.layout, meetingId: MEETING_ID,
    signal: new AbortController().signal });
  void pending.catch(() => { settled = true; });
  const rejected = expect(pending).rejects.toMatchObject({ code: "HELPER_PROCESS_ERROR" });
  value.handle.outcome.resolve({ exitCode: 0, signal: null });
  await vi.waitFor(async () => expect(JSON.parse(await readFile(
    join(value.sessionRoot, "control", "host-cancel.json"), "utf8"))).toMatchObject({ cancel: true }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(settled).toBe(false);
  await cancellationAcknowledgement(value);
  await rejected;
});

it.each(["wrong-schema", "false", "symlink"])("rejects an unsafe cancellation acknowledgement: %s", async (kind) => {
  const value = await fixture(50, 80);
  const control = join(value.sessionRoot, "control");
  await mkdir(control, { recursive: true, mode: 0o700 });
  const path = join(control, "host-cancelled.json");
  if (kind === "symlink") {
    const external = join(value.sessionRoot, "external.json");
    await writeFile(external, JSON.stringify({ schema_version: 1, cancelled: true }), { mode: 0o600 });
    await symlink(external, path);
  } else {
    await writeFile(path, JSON.stringify({ schema_version: kind === "wrong-schema" ? true : 1,
      cancelled: kind !== "false" }), { mode: 0o600 });
  }
  const pending = value.client.start({ layout: value.layout, meetingId: MEETING_ID,
    signal: new AbortController().signal });
  await expect(pending).rejects.toMatchObject({ code: "HELPER_PROTOCOL_ERROR" });
  value.handle.outcome.resolve({ exitCode: 0, signal: null });
});

it("accepts native failure cleanup only after its normal-stop marker and launcher exit", async () => {
  const value = await fixture(50);
  const control = join(value.sessionRoot, "control");
  await mkdir(control, { recursive: true, mode: 0o700 });
  await writeFile(join(control, "capture-pids.json"), "{}", { mode: 0o600 });
  await writeFile(join(control, "normal-stop.marker"), JSON.stringify({ schema_version: 1, normal_stop: true }),
    { mode: 0o600 });
  const pending = value.client.start({ layout: value.layout, meetingId: MEETING_ID,
    signal: new AbortController().signal });
  const rejected = expect(pending).rejects.toMatchObject({ code: "HELPER_PROCESS_ERROR" });
  value.handle.outcome.resolve({ exitCode: 0, signal: null });
  await rejected;
});

it("uses watchdog cancellation when a running Helper cannot acknowledge stop", async () => {
  const value = await fixture();
  const session = await ready(value);
  value.handle.outcome.resolve({ exitCode: 0, signal: null });
  await expect(session.completion).rejects.toMatchObject({ code: "HELPER_PROCESS_ERROR" });
  const terminating = session.terminate();
  await cancellationAcknowledgement(value);
  await terminating;
});

it("invalidates requested track snapshots when the helper process dies", async () => {
  const value = await fixture();
  const session = await ready(value);

  value.handle.outcome.resolve({ exitCode: null, signal: "SIGKILL" });

  await expect(session.completion).rejects.toMatchObject({ code: "HELPER_PROCESS_ERROR" });
  expect(session.snapshot()).toMatchObject({
    mic: { requested: true, state: "failed", errorCode: "HELPER_PROCESS_ERROR" },
    system: { requested: true, state: "failed", errorCode: "HELPER_PROCESS_ERROR" },
  });
});

it("invalidates tracks when LaunchServices exits without a helper terminal event", async () => {
  const value = await fixture();
  const session = await ready(value);

  value.handle.outcome.resolve({ exitCode: 0, signal: null });

  await expect(session.completion).rejects.toMatchObject({ code: "HELPER_PROCESS_ERROR" });
  expect(session.snapshot()).toMatchObject({
    mic: { requested: true, state: "failed", errorCode: "HELPER_PROCESS_ERROR" },
    system: { requested: true, state: "failed", errorCode: "HELPER_PROCESS_ERROR" },
  });
});
