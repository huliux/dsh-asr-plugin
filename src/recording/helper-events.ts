import { constants } from "node:fs";
import { open } from "node:fs/promises";

import type { RecordingHelperTrackSnapshot, RecordingTrack } from "./recording-session.js";

const MAX_EVENT_BYTES = 4 * 1_024;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

interface EventBase {
  readonly eventSeq: number;
}

export type RecordingHelperEvent =
  | (EventBase & {
    readonly type: "track_state";
    readonly track: RecordingTrack;
    readonly value: RecordingHelperTrackSnapshot;
  })
  | (EventBase & {
    readonly type: "helper_ready";
    readonly meetingId: string;
    readonly mic: RecordingHelperTrackSnapshot;
    readonly system: RecordingHelperTrackSnapshot;
  })
  | (EventBase & {
    readonly type: "chunk_closed";
    readonly endUs: number;
  })
  | (EventBase & {
    readonly type: "command_applied";
    readonly commandId: number;
    readonly errorCode: string | null;
    readonly mic: RecordingHelperTrackSnapshot;
    readonly result: "ok" | "error";
    readonly system: RecordingHelperTrackSnapshot;
  })
  | (EventBase & { readonly type: "helper_stopped" })
  | (EventBase & { readonly type: "helper_failed"; readonly errorCode: string });

export class RecordingHelperProtocolError extends Error {
  constructor(readonly code = "HELPER_PROTOCOL_ERROR", options?: ErrorOptions) {
    super("Recording helper journal is invalid", options);
    this.name = "RecordingHelperProtocolError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecordingHelperProtocolError();
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new RecordingHelperProtocolError();
  }
}

function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > MAX_SAFE_INTEGER) {
    throw new RecordingHelperProtocolError();
  }
  return Number(value);
}

function errorCode(value: unknown, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,99}$/u.test(value)) {
    throw new RecordingHelperProtocolError();
  }
  return value;
}

function track(value: unknown): RecordingHelperTrackSnapshot {
  const item = record(value);
  exact(item, ["state", "requested", "error_code"]);
  if (!(["off", "starting", "on", "failed"] as const).includes(
    item.state as "off" | "starting" | "on" | "failed",
  ) || typeof item.requested !== "boolean") {
    throw new RecordingHelperProtocolError();
  }
  return {
    state: item.state as RecordingHelperTrackSnapshot["state"],
    requested: item.requested,
    errorCode: errorCode(item.error_code, true),
  };
}

function tracks(value: unknown) {
  const item = record(value);
  exact(item, ["mic", "system"]);
  return { mic: track(item.mic), system: track(item.system) };
}

function parseKnownEvent(item: Record<string, unknown>, eventSeq: number): RecordingHelperEvent {
  if (item.type === "track_state") {
    exact(item, ["schema_version", "event_seq", "type", "track", "state", "requested", "error_code"]);
    if (item.track !== "mic" && item.track !== "system") throw new RecordingHelperProtocolError();
    return {
      type: "track_state",
      eventSeq,
      track: item.track,
      value: track({ state: item.state, requested: item.requested, error_code: item.error_code }),
    };
  }
  if (item.type === "helper_ready") {
    exact(item, ["schema_version", "event_seq", "type", "meeting_id", "tracks"]);
    if (typeof item.meeting_id !== "string") throw new RecordingHelperProtocolError();
    return { type: "helper_ready", eventSeq, meetingId: item.meeting_id, ...tracks(item.tracks) };
  }
  if (item.type === "chunk_closed") {
    exact(item, ["schema_version", "event_seq", "type", "track", "start_us", "end_us", "frame_count"]);
    if (item.track !== "mic" && item.track !== "system") throw new RecordingHelperProtocolError();
    const startUs = integer(item.start_us);
    const endUs = integer(item.end_us, startUs + 1);
    integer(item.frame_count, 1);
    return { type: "chunk_closed", eventSeq, endUs };
  }
  if (item.type === "command_applied") {
    exact(item, ["schema_version", "event_seq", "type", "command_id", "result", "error_code", "tracks"]);
    if (item.result !== "ok" && item.result !== "error") throw new RecordingHelperProtocolError();
    return {
      type: "command_applied",
      eventSeq,
      commandId: integer(item.command_id, 1),
      result: item.result,
      errorCode: errorCode(item.error_code, true),
      ...tracks(item.tracks),
    };
  }
  if (item.type === "helper_stopped") {
    exact(item, ["schema_version", "event_seq", "type", "reason"]);
    if (item.reason !== "command" && item.reason !== "signal") throw new RecordingHelperProtocolError();
    return { type: "helper_stopped", eventSeq };
  }
  if (item.type === "helper_failed") {
    exact(item, ["schema_version", "event_seq", "type", "error_code"]);
    return { type: "helper_failed", eventSeq, errorCode: errorCode(item.error_code, false)! };
  }
  throw new RecordingHelperProtocolError();
}

export function parseRecordingHelperEvent(value: unknown, expectedSequence: number) {
  const item = record(value);
  if (item.schema_version !== 1 || integer(item.event_seq, 1) !== expectedSequence ||
    typeof item.type !== "string") {
    throw new RecordingHelperProtocolError();
  }
  return parseKnownEvent(item, expectedSequence);
}

function changed(before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>, after: typeof before) {
  return before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs;
}

async function readJournal(path: string): Promise<Record<string, unknown> | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_EVENT_BYTES ||
      (before.mode & 0o077) !== 0 || before.uid !== process.geteuid?.()) {
      throw new RecordingHelperProtocolError();
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (changed(before, after)) throw new RecordingHelperProtocolError();
    return record(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    if (error instanceof RecordingHelperProtocolError) throw error;
    throw new RecordingHelperProtocolError("HELPER_PROTOCOL_ERROR", { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readRecordingHelperEvent(
  path: string,
  expectedSequence: number,
): Promise<RecordingHelperEvent | null> {
  const value = await readJournal(path);
  return value === null ? null : parseRecordingHelperEvent(value, expectedSequence);
}

export async function readRecordingHelperControlFlag(
  path: string,
  key: "cancelled" | "normal_stop",
): Promise<boolean> {
  const value = await readJournal(path);
  if (value === null) return false;
  exact(value, ["schema_version", key]);
  if (value.schema_version !== 1 || value[key] !== true) throw new RecordingHelperProtocolError();
  return true;
}
