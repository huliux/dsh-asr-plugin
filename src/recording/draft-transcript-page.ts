import { createHash, timingSafeEqual } from "node:crypto";

import type { DraftTranscriptSegment, DraftTranscriptSnapshot } from "./worker-types.js";

const CURSOR_DOMAIN = "dsh-asr-plugin.draft-cursor.v1\0";
const MAX_RETAINED_SNAPSHOTS = 4;
const RETAINED_SNAPSHOT_TTL_MS = 5 * 60 * 1_000;
const MAX_CURSOR_LENGTH = 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type DraftTranscriptPageErrorCode = "INVALID_INPUT" | "DRAFT_REVISION_CONFLICT";

export class DraftTranscriptPageError extends Error {
  constructor(readonly code: DraftTranscriptPageErrorCode, message: string) {
    super(message);
    this.name = "DraftTranscriptPageError";
  }
}

export interface GetDraftTranscriptPageInput {
  readonly meetingId: string;
  readonly snapshot: DraftTranscriptSnapshot;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface DraftTranscriptPage {
  readonly revision: number;
  readonly audioThroughMs: number;
  readonly generatedAtMs: number;
  readonly segments: readonly DraftTranscriptSegment[];
  readonly nextCursor: string | null;
}

interface DraftCursor {
  readonly kind: "draft";
  readonly meetingId: string;
  readonly revision: number;
  readonly lastSeq: number;
}

interface RetainedDraftSnapshot {
  readonly expiresAtMs: number;
  readonly snapshot: DraftTranscriptSnapshot;
}

function snapshotKey(meetingId: string, revision: number): string {
  return `${meetingId}:${revision}`;
}

function copySnapshot(snapshot: DraftTranscriptSnapshot): DraftTranscriptSnapshot {
  return {
    revision: snapshot.revision,
    audioThroughMs: snapshot.audioThroughMs,
    generatedAtMs: snapshot.generatedAtMs,
    segments: snapshot.segments.map((segment) => ({ ...segment })),
  };
}

function invalid(message = "Draft cursor is invalid; restart from the first page and use next_cursor verbatim"): never {
  throw new DraftTranscriptPageError("INVALID_INPUT", message);
}

function digest(body: string): string {
  return createHash("sha256").update(CURSOR_DOMAIN).update(body).digest("hex");
}

function encodeCursor(cursor: Omit<DraftCursor, "kind">): string {
  const body = JSON.stringify({ kind: "draft", ...cursor });
  return Buffer.from(`${body}.${digest(body)}`).toString("base64url");
}

function cursorEnvelope(cursor: string): Record<string, unknown> {
  if (
    cursor.length < 1 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) invalid();
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) invalid();
    const envelope = bytes.toString("utf8");
    const separator = envelope.lastIndexOf(".");
    if (separator < 1) invalid();
    const body = envelope.slice(0, separator);
    const actual = envelope.slice(separator + 1);
    const expected = digest(body);
    if (
      !/^[0-9a-f]{64}$/.test(actual) ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    ) invalid();
    const payload: unknown = JSON.parse(body);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) invalid();
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DraftTranscriptPageError) throw error;
    return invalid();
  }
}

function decodeCursor(cursor: string): DraftCursor {
  const value = cursorEnvelope(cursor);
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    !["kind", "meetingId", "revision", "lastSeq"].every((key) => keys.includes(key)) ||
    value.kind !== "draft" ||
    !UUID_PATTERN.test(String(value.meetingId)) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Number.isSafeInteger(value.lastSeq) ||
    (value.lastSeq as number) < 0
  ) invalid();
  return value as unknown as DraftCursor;
}

export function isDraftTranscriptCursor(value: string): boolean {
  try {
    decodeCursor(value);
    return true;
  } catch {
    return false;
  }
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    invalid("Draft limit must be an integer in 1..100; omit limit to use 50");
  }
  return value;
}

function boundary(input: GetDraftTranscriptPageInput): number {
  if (input.cursor === undefined) return -1;
  if (typeof input.cursor !== "string") invalid();
  const cursor = decodeCursor(input.cursor);
  if (cursor.meetingId !== input.meetingId) invalid("Draft cursor does not match meeting");
  if (cursor.revision !== input.snapshot.revision) {
    throw new DraftTranscriptPageError(
      "DRAFT_REVISION_CONFLICT",
      "Draft cursor revision changed; restart from the latest first page",
    );
  }
  if (cursor.lastSeq >= input.snapshot.segments.length) invalid();
  return cursor.lastSeq;
}

export function getDraftTranscriptPage(
  input: GetDraftTranscriptPageInput,
): DraftTranscriptPage {
  if (!UUID_PATTERN.test(input.meetingId)) invalid("Meeting id is invalid");
  const limit = pageLimit(input.limit);
  const afterSeq = boundary(input);
  const remaining = input.snapshot.segments.slice(afterSeq + 1, afterSeq + limit + 2);
  const segments = remaining.slice(0, limit).map((segment) => ({ ...segment }));
  const last = segments.at(-1);
  const nextCursor = remaining.length > limit && last !== undefined
    ? encodeCursor({ meetingId: input.meetingId, revision: input.snapshot.revision, lastSeq: last.seq })
    : null;
  return {
    revision: input.snapshot.revision,
    audioThroughMs: input.snapshot.audioThroughMs,
    generatedAtMs: input.snapshot.generatedAtMs,
    segments,
    nextCursor,
  };
}

export class DraftTranscriptPager {
  private readonly retained = new Map<string, RetainedDraftSnapshot>();

  constructor(private readonly now: () => number = Date.now) {}

  page(input: GetDraftTranscriptPageInput): DraftTranscriptPage {
    const nowMs = this.now();
    this.expire(nowMs);
    const snapshot = this.snapshot(input);
    const page = getDraftTranscriptPage({ ...input, snapshot });
    if (input.cursor === undefined && page.nextCursor !== null) {
      this.retain(input.meetingId, snapshot, nowMs);
    }
    return page;
  }

  private expire(nowMs: number): void {
    for (const [key, retained] of this.retained) {
      if (retained.expiresAtMs <= nowMs) this.retained.delete(key);
    }
  }

  private retain(meetingId: string, snapshot: DraftTranscriptSnapshot, nowMs: number): void {
    const key = snapshotKey(meetingId, snapshot.revision);
    this.retained.delete(key);
    while (this.retained.size >= MAX_RETAINED_SNAPSHOTS) {
      const oldest = this.retained.keys().next();
      if (oldest.done) break;
      this.retained.delete(oldest.value);
    }
    this.retained.set(key, {
      expiresAtMs: nowMs + RETAINED_SNAPSHOT_TTL_MS,
      snapshot: copySnapshot(snapshot),
    });
  }

  private snapshot(input: GetDraftTranscriptPageInput): DraftTranscriptSnapshot {
    if (input.cursor === undefined) return input.snapshot;
    const cursor = decodeCursor(input.cursor);
    if (cursor.meetingId !== input.meetingId) return input.snapshot;
    const retained = this.retained.get(snapshotKey(input.meetingId, cursor.revision));
    if (retained === undefined) {
      throw new DraftTranscriptPageError(
        "DRAFT_REVISION_CONFLICT",
        "Draft cursor snapshot is unavailable; restart from the latest first page",
      );
    }
    return retained.snapshot;
  }
}
