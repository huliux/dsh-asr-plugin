import type { DatabaseSync } from "node:sqlite";
import { parse } from "node:path";

import { inReadOperation } from "./database.js";
import { MeetingRepositoryError } from "./errors.js";
import { parseMeetingRow } from "./row-mappers.js";
import type { ListMeetingReferenceRecordsInput, MeetingRecord } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface ReferenceQuery {
  readonly locale: string;
  readonly needle: string | null;
}

function validate(input: ListMeetingReferenceRecordsInput): void {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20
    || typeof input.locale !== "string" || input.locale.length > 100
    || (input.query !== undefined && typeof input.query !== "string")
    || (input.preferredMeetingId !== undefined
      && !UUID_PATTERN.test(input.preferredMeetingId))) {
    throw new MeetingRepositoryError("INVALID_INPUT", "Meeting reference query is invalid");
  }
}

function referenceQuery(input: ListMeetingReferenceRecordsInput): ReferenceQuery {
  validate(input);
  let locale: string;
  try {
    const locales = Intl.getCanonicalLocales(input.locale);
    if (locales.length !== 1) throw new RangeError();
    locale = locales[0]!;
  } catch {
    throw new MeetingRepositoryError("INVALID_INPUT", "Meeting reference locale is invalid");
  }
  const query = input.query?.trim().normalize("NFKC") ?? "";
  if (Array.from(query).length > 500) {
    throw new MeetingRepositoryError("INVALID_INPUT", "Meeting reference query is too long");
  }
  return { locale, needle: query === "" ? null : query.toLocaleLowerCase(locale) };
}

function matchRank(meeting: MeetingRecord, query: ReferenceQuery): number | null {
  const values = [meeting.title, parse(meeting.sourceName).name]
    .map((value) => value.trim().normalize("NFKC").toLocaleLowerCase(query.locale));
  let rank: number | null = null;
  for (const value of values) {
    const next = value === query.needle ? 0 : value.startsWith(query.needle!) ? 1
      : value.includes(query.needle!) ? 2 : null;
    if (next !== null && (rank === null || next < rank)) rank = next;
  }
  return rank;
}

function matchingRecords(
  database: DatabaseSync,
  input: ListMeetingReferenceRecordsInput,
  query: ReferenceQuery,
): readonly MeetingRecord[] {
  const ranked: MeetingRecord[][] = [[], [], []];
  const rows = database.prepare(`
    SELECT * FROM meetings WHERE status <> 'deleting'
    ORDER BY created_at_ms DESC, meeting_id DESC
  `).iterate();
  for (const row of rows) {
    const meeting = parseMeetingRow(row);
    const rank = matchRank(meeting, query);
    if (rank !== null && ranked[rank]!.length < input.limit) ranked[rank]!.push(meeting);
  }
  return ranked.flat().slice(0, input.limit);
}

function recentRecords(
  database: DatabaseSync,
  input: ListMeetingReferenceRecordsInput,
): readonly MeetingRecord[] {
  const preferred = input.preferredMeetingId;
  const rows = preferred === undefined
    ? database.prepare(`
      SELECT * FROM meetings WHERE status <> 'deleting'
      ORDER BY created_at_ms DESC, meeting_id DESC LIMIT ?
    `).all(input.limit)
    : database.prepare(`
      SELECT * FROM meetings WHERE status <> 'deleting'
      ORDER BY (meeting_id = ?) DESC, created_at_ms DESC, meeting_id DESC LIMIT ?
    `).all(preferred, input.limit);
  return rows.map(parseMeetingRow);
}

export function listMeetingReferenceRecords(
  database: DatabaseSync,
  input: ListMeetingReferenceRecordsInput,
): readonly MeetingRecord[] {
  const query = referenceQuery(input);
  return inReadOperation(() => {
    return query.needle === null
      ? recentRecords(database, input)
      : matchingRecords(database, input, query);
  });
}
