import type { TranscriptExportFormat } from "../transcript-projection/transcript-projection.js";

const MAX_SLUG_LENGTH = 64;

export interface TranscriptFileNameInput {
  readonly createdAtMs: number;
  readonly meetingId: string;
  readonly recordingStartedAtMs: number | null;
  readonly title: string;
}

/**
 * Compact UTC stamp used both in the fallback name and inside default titles.
 * Colons are not valid in file names on some file systems, so they collapse.
 */
export function transcriptExportStamp(epochMs: number): string {
  return new Date(epochMs).toISOString()
    .replace(/\.\d{3}Z$/u, "z")
    .replace(/:/gu, "-")
    .toLowerCase();
}

function slugOf(title: string): string {
  const normalized = title.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "");
  const ascii = normalized.replace(/[^0-9a-zA-Z]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
  return ascii.slice(0, MAX_SLUG_LENGTH).replace(/-+$/gu, "");
}

/**
 * Deterministic export name: a readable title slug plus the recording stamp.
 * Names stay ASCII so they survive every file system the picker can reach.
 */
export function transcriptExportFileName(
  meeting: TranscriptFileNameInput,
  format: TranscriptExportFormat,
): string {
  const stamp = transcriptExportStamp(meeting.recordingStartedAtMs ?? meeting.createdAtMs);
  const slug = slugOf(meeting.title);
  // A default title already carries the ISO stamp, so compare the minute part
  // and avoid repeating the same instant twice in the file name.
  const base = slug === "" ? `transcript-${stamp}` : slug.includes(stamp.replace(/z$/u, ""))
    ? slug
    : `${slug}-${stamp}`;
  const trimmed = base.slice(0, 96).replace(/-+$/gu, "");
  return `${trimmed === "" ? `transcript-${stamp}` : trimmed}.${format}`;
}
