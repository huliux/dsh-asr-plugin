import path from "node:path";

import type {
  OkfActionItem,
  OkfActionState,
  OkfDeadline,
  OkfFile,
  OkfSourceRef,
} from "./contracts.js";
import type { ParsedFields } from "./frontmatter-read.js";
import { parseFrontmatter } from "./frontmatter-read.js";
import { OKF_ACTIONS_INDEX, OKF_DEADLINES_INDEX } from "./paths.js";

/** Facts the rollups need, read back from authored pages instead of SQLite. */
export interface OkfRollupPages {
  readonly actions: readonly OkfActionItem[];
  readonly deadlines: readonly OkfDeadline[];
}

const PAGE_ENDING = ".md";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/u;
const INTEGER = /^-?\d+$/u;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function textValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : value[0];
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
}

function listValue(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  const items = typeof value === "string" ? [value] : value;
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

function parseState(value: string | readonly string[] | undefined): OkfActionState | undefined {
  const text = textValue(value);
  return text === "open" || text === "done" || text === "dropped" ? text : undefined;
}

/** ISO calendar dates and timestamps only, so parsing never depends on the host. */
function parseEpochMs(value: string | readonly string[] | undefined): number | undefined {
  const text = textValue(value);
  if (text === undefined || !ISO_DATE.test(text)) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseInteger(value: string | readonly string[] | undefined): number | undefined {
  const text = textValue(value);
  if (text === undefined || !INTEGER.test(text)) return undefined;
  const parsed = Number.parseInt(text, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function pageSlug(pagePath: string): string {
  return path.posix.basename(pagePath, PAGE_ENDING);
}

function normalisePagePath(relativePath: string): string {
  return path.posix.normalize(relativePath.replace(/^\.\//u, "")).replace(/^\/+/u, "");
}

function readActionPage(pagePath: string, fields: ParsedFields): OkfActionItem | undefined {
  const state = parseState(fields["state"]);
  const title = textValue(fields["title"]);
  if (state === undefined || title === undefined) return undefined;
  const owner = textValue(fields["owner"]);
  const dueAtMs = parseEpochMs(fields["due"]);
  const transcriptVersion = parseInteger(fields["transcript_version"]) ?? 0;
  const sources = listValue(fields["sources"])
    .map<OkfSourceRef>((meetingId) => ({ meetingId, transcriptVersion }));
  return {
    id: textValue(fields["id"]) ?? pageSlug(pagePath),
    title,
    state,
    sources,
    ...(owner === undefined ? {} : { owner }),
    ...(dueAtMs === undefined ? {} : { dueAtMs }),
  };
}

function readDeadlinePage(pagePath: string, fields: ParsedFields): OkfDeadline | undefined {
  const state = parseState(fields["state"]);
  const title = textValue(fields["title"]);
  const dueAtMs = parseEpochMs(fields["due"]);
  const meetingId = textValue(fields["meeting_id"]) ?? listValue(fields["sources"])[0];
  if (state === undefined || title === undefined || dueAtMs === undefined) return undefined;
  if (meetingId === undefined) return undefined;
  const owner = textValue(fields["owner"]);
  return {
    id: textValue(fields["id"]) ?? pageSlug(pagePath),
    title,
    dueAtMs,
    state,
    meetingId,
    ...(owner === undefined ? {} : { owner }),
  };
}

/**
 * Read bundle pages back into rollup facts.
 *
 * Only `actions/*.md` and `deadlines/*.md` pages carrying a `state` field are
 * understood; everything else, including pages an agent wrote in a shape this
 * reader does not know, is skipped rather than failing the whole ingestion.
 * Results sort by id so the caller sees a stable order regardless of input.
 */
export function readOkfPages(files: readonly OkfFile[]): OkfRollupPages {
  const actions: OkfActionItem[] = [];
  const deadlines: OkfDeadline[] = [];
  for (const file of files) {
    const pagePath = normalisePagePath(file.relativePath);
    if (!pagePath.endsWith(PAGE_ENDING)) continue;
    if (pagePath === OKF_ACTIONS_INDEX || pagePath === OKF_DEADLINES_INDEX) continue;
    const { fields } = parseFrontmatter(file.content);
    if (pagePath.startsWith("actions/")) {
      const action = readActionPage(pagePath, fields);
      if (action !== undefined) actions.push(action);
    } else if (pagePath.startsWith("deadlines/")) {
      const deadline = readDeadlinePage(pagePath, fields);
      if (deadline !== undefined) deadlines.push(deadline);
    }
  }
  actions.sort((left, right) => compareText(left.id, right.id) || compareText(left.title, right.title));
  deadlines.sort((left, right) => compareText(left.id, right.id) || compareText(left.title, right.title));
  return { actions, deadlines };
}
