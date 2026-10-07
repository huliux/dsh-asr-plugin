import type { ModelDownloadControl } from "../assets/model-download-contract.js";
import type { ModelSettingsStatus } from "../assets/model-settings-contract.js";
import type { RecordingPermissionControl } from "./permission-contract.js";
import type { MeetingApplication } from "../application/meeting-application.js";
import type { MeetingReferenceCandidate } from "../application/meeting-reference.js";
import type { RecordingControlInput } from "../application/recording-application.js";
import {
  RECORDING_RPC_CHANNEL,
  type MeetingReferenceRpcCandidatesPayload,
  type MeetingReferenceRpcResolvePayload,
  type RecordingRpcControlPayload,
  type RecordingRpcResult,
} from "./rpc-contract.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type RecordingRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RecordingRpcResult>;

export interface RecordingRpcConnection {
  readonly rpc: {
    handle(
      channel: string,
      handler: RecordingRpcHandler,
      options: { readonly authority: "loopback" },
    ): () => Promise<void>;
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function inputError(): never {
  throw new Error("INVALID_INPUT");
}

function emptyPayload(payload: unknown): void {
  const value = record(payload);
  if (value === null || Object.keys(value).length !== 0) inputError();
}

function control(payload: unknown, signal: AbortSignal): RecordingControlInput {
  const value = record(payload);
  if (value === null || !exact(value, ["action", "meeting_id", "title"]) ||
    typeof value.action !== "string") inputError();
  const action = value.action as RecordingRpcControlPayload["action"];
  if (action === "start") {
    if (value.meeting_id !== undefined ||
      (value.title !== undefined && typeof value.title !== "string")) inputError();
    return {
      action,
      signal,
      ...(value.title === undefined ? {} : { title: value.title as string }),
    };
  }
  if (!(["stop", "mic_on", "mic_off", "system_on", "system_off"] as const).includes(action) ||
    typeof value.meeting_id !== "string" || value.title !== undefined) inputError();
  return { action, meetingId: value.meeting_id, signal };
}

function failure(error: unknown): RecordingRpcResult {
  const code = typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : "ENGINE_FAILURE";
  return { ok: false, error: { code: "internal", message: code, details: {} } };
}

function referenceCandidatesPayload(payload: unknown): MeetingReferenceRpcCandidatesPayload {
  const value = record(payload);
  if (value === null || !exact(value, ["session_id", "locale", "query"])
    || typeof value.session_id !== "string" || value.session_id.length < 1
    || value.session_id.length > 500 || typeof value.locale !== "string"
    || (value.query !== undefined && typeof value.query !== "string")) inputError();
  return {
    session_id: value.session_id,
    locale: value.locale,
    ...(value.query === undefined ? {} : { query: value.query as string }),
  };
}

function referenceResolvePayload(payload: unknown): MeetingReferenceRpcResolvePayload {
  const value = record(payload);
  if (value === null || !exact(value, ["locale", "meeting_id"])
    || typeof value.locale !== "string"
    || typeof value.meeting_id !== "string" || !UUID_PATTERN.test(value.meeting_id)) inputError();
  return { locale: value.locale, meeting_id: value.meeting_id };
}

function referenceValue(candidate: MeetingReferenceCandidate) {
  const timestamp = (value: number | null) => value === null ? null : new Date(value).toISOString();
  return {
    meeting_id: candidate.meetingId,
    label: candidate.label,
    origin: candidate.origin,
    phase: candidate.phase,
    started_at: timestamp(candidate.startedAtMs),
    created_at: timestamp(candidate.createdAtMs)!,
    recording_elapsed_ms: candidate.recordingElapsedMs,
    duration_ms: candidate.durationMs,
  };
}

export function registerRecordingHostRpc(
  connection: RecordingRpcConnection,
  application: MeetingApplication,
  modelStatus?: (signal: AbortSignal) => Promise<ModelSettingsStatus>,
  downloads?: ModelDownloadControl,
  permissions?: RecordingPermissionControl,
  prepareModels?: (signal: AbortSignal) => Promise<void>,
): () => Promise<void> {
  return connection.rpc.handle(RECORDING_RPC_CHANNEL, async (endpoint, payload, signal) => {
    try {
      if (endpoint === "models/prepare" && prepareModels !== undefined) {
        emptyPayload(payload);
        await prepareModels(signal);
        return { ok: true, value: null };
      }
      if (endpoint.startsWith("permissions/") && permissions !== undefined) {
        if (endpoint === "permissions/open-settings") {
          const value = record(payload);
          if (value === null || !exact(value, ["track"]) ||
              (value.track !== "microphone" && value.track !== "system")) inputError();
          await permissions.openSettings(value.track, signal);
          return { ok: true, value: null };
        }
        emptyPayload(payload);
        if (endpoint === "permissions/status") return { ok: true, value: await permissions.read(signal) };
        if (endpoint === "permissions/test") {
          const phase = application.getRecordingState()?.phase;
          if (phase !== undefined && ["starting", "recording", "finalizing"].includes(phase)) {
            throw Object.assign(new Error("Recording is active"), {code:"ENGINE_BUSY"});
          }
          return { ok: true, value: await permissions.test(signal) };
        }
      }
      if (endpoint.startsWith("models/download/") && downloads !== undefined) {
        if (endpoint === "models/download/start") {
          const value = record(payload);
          if (value === null || !exact(value, ["pack"]) ||
            (value.pack !== "base" && value.pack !== "punctuation")) inputError();
          return { ok: true, value: await downloads.start(value.pack) };
        }
        emptyPayload(payload);
        if (endpoint === "models/download/status") return { ok: true, value: downloads.status() };
        if (endpoint === "models/download/cancel") return { ok: true, value: await downloads.cancel() };
      }
      if (endpoint === "models/status" && modelStatus !== undefined) {
        emptyPayload(payload);
        return { ok: true, value: await modelStatus(signal) };
      }
      if (endpoint === "state") {
        emptyPayload(payload);
        return {
          ok: true,
          value: {
            recording: application.getRecordingState(),
            preview: application.getRecordingPreview(),
            hasRecordingHistory: application.hasRecordingHistory(),
          },
        };
      }
      if (endpoint === "control") {
        return { ok: true, value: await application.controlRecording(control(payload, signal)) };
      }
      if (endpoint === "references/candidates") {
        const request = referenceCandidatesPayload(payload);
        return {
          ok: true,
          value: application.getMeetingReferenceCandidates({
            locale: request.locale,
            ...(request.query === undefined ? {} : { query: request.query }),
          }).map(referenceValue),
        };
      }
      if (endpoint === "references/resolve") {
        const request = referenceResolvePayload(payload);
        return {
          ok: true,
          value: referenceValue(application.resolveMeetingReference({
            locale: request.locale,
            meetingId: request.meeting_id,
          })),
        };
      }
      throw new Error("UNKNOWN_ENDPOINT");
    } catch (error) {
      return failure(error);
    }
  }, { authority: "loopback" });
}
