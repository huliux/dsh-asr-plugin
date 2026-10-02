import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openMeetingRepository,
  type MeetingRepository,
  type TranscriptSegment,
} from "../../src/storage/meeting-repository.js";

export interface TemporaryMeetingRepository {
  readonly filename: string;
  readonly repository: MeetingRepository;
  readonly root: string;
}

export interface CommitMeetingOptions {
  readonly createdAtMs?: number;
  readonly sourceName?: string;
  readonly texts: readonly string[];
  readonly title?: string;
}

export function meetingId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

export function importRunId(index: number): string {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

export function retranscribeRunId(index: number): string {
  return `20000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

export async function createTemporaryMeetingRepository(): Promise<TemporaryMeetingRepository> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-query-"));
  const filename = join(root, "meetings.sqlite3");
  return { filename, repository: openMeetingRepository(filename), root };
}

function segmentsFor(texts: readonly string[]): TranscriptSegment[] {
  return texts.map((text, seq) => ({
    seq,
    startMs: seq * 1_000,
    endMs: seq * 1_000 + 500,
    speakerLabel: seq % 2 === 0 ? "Speaker A" : "Speaker B",
    text,
  }));
}

export function commitMeeting(
  repository: MeetingRepository,
  index: number,
  options: CommitMeetingOptions,
): void {
  const createdAtMs = options.createdAtMs ?? index * 1_000;
  repository.createImport({
    meetingId: meetingId(index),
    title: options.title ?? `会议 ${index}`,
    sourceName: options.sourceName ?? `meeting-${index}.wav`,
    sourceFormat: "wav",
    sourceSizeBytes: 1_024,
    runId: importRunId(index),
    nowMs: createdAtMs,
  });
  repository.commitTranscript({
    meetingId: meetingId(index),
    runId: importRunId(index),
    baseVersion: 0,
    resultStatus: "completed",
    resultReason: null,
    durationMs: Math.max(1_000, options.texts.length * 1_000),
    engineFingerprint: "a".repeat(64),
    segments: segmentsFor(options.texts),
    nowMs: createdAtMs + 1,
  });
}
