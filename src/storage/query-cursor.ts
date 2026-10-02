import { createHash, timingSafeEqual } from "node:crypto";

import { MeetingRepositoryError } from "./errors.js";

const CURSOR_DOMAIN = "dsh-asr-plugin.cursor.v1\0";
const MAX_CURSOR_LENGTH = 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface TranscriptCursor {
  readonly kind: "transcript";
  readonly meetingId: string;
  readonly version: number;
  readonly lastSeq: number;
  readonly projection?: "page" | "agent";
  readonly nextSegmentDigest?: string;
}

export interface SearchCursor {
  readonly kind: "search";
  readonly queryHash: string;
  readonly createdAtMs: number;
  readonly meetingId: string;
}

function invalidCursor(): never {
  throw new MeetingRepositoryError("INVALID_INPUT", "Pagination cursor is invalid");
}

function digest(body: string): string {
  return createHash("sha256").update(CURSOR_DOMAIN).update(body).digest("hex");
}

function encodeCursor(payload: TranscriptCursor | SearchCursor): string {
  const body = JSON.stringify(payload);
  return Buffer.from(`${body}.${digest(body)}`).toString("base64url");
}

function decodeEnvelope(cursor: string): Record<string, unknown> {
  if (cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalidCursor();
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) invalidCursor();
    const envelope = bytes.toString("utf8");
    const separator = envelope.lastIndexOf(".");
    if (separator < 1) invalidCursor();
    const body = envelope.slice(0, separator);
    const actual = envelope.slice(separator + 1);
    const expected = digest(body);
    if (!/^[0-9a-f]{64}$/.test(actual)
      || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) invalidCursor();
    const payload: unknown = JSON.parse(body);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) invalidCursor();
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof MeetingRepositoryError) throw error;
    return invalidCursor();
  }
}

export function encodeTranscriptCursor(payload: Omit<TranscriptCursor, "kind">): string {
  return encodeCursor({ kind: "transcript", ...payload });
}

export function decodeTranscriptCursor(cursor: string): TranscriptCursor {
  const payload = decodeEnvelope(cursor);
  if (payload.kind !== "transcript" || !UUID_PATTERN.test(String(payload.meetingId))
    || !Number.isSafeInteger(payload.version) || (payload.version as number) < 1
    || !Number.isSafeInteger(payload.lastSeq) || (payload.lastSeq as number) < 0
    || (payload.projection !== undefined
      && payload.projection !== "page" && payload.projection !== "agent")
    || (payload.nextSegmentDigest !== undefined
      && (payload.projection !== "agent"
        || !/^[0-9a-f]{64}$/.test(String(payload.nextSegmentDigest))))) invalidCursor();
  return payload as unknown as TranscriptCursor;
}

export function encodeSearchCursor(payload: Omit<SearchCursor, "kind">): string {
  return encodeCursor({ kind: "search", ...payload });
}

export function decodeSearchCursor(cursor: string): SearchCursor {
  const payload = decodeEnvelope(cursor);
  if (payload.kind !== "search" || !/^[0-9a-f]{64}$/.test(String(payload.queryHash))
    || !Number.isSafeInteger(payload.createdAtMs) || (payload.createdAtMs as number) <= 0
    || !UUID_PATTERN.test(String(payload.meetingId))) invalidCursor();
  return payload as unknown as SearchCursor;
}
