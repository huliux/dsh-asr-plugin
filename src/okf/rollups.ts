import path from "node:path";

import type {
  OkfActionItem,
  OkfBundleRow,
  OkfDeadline,
  OkfFile,
  OkfRollupInput,
} from "./contracts.js";
import { renderDocument } from "./frontmatter.js";
import {
  OKF_ACTIONS_INDEX,
  OKF_DEADLINES_INDEX,
  OKF_MEETINGS_INDEX,
  OKF_ROOT_INDEX,
  actionRelativePath,
} from "./paths.js";

export { readOkfPages, type OkfRollupPages } from "./rollup-read.js";

/**
 * Rollup set: root, meetings, actions and deadlines indexes. `meetings/index.md`
 * is included because the root page lists only the ten most recent meetings,
 * while the bundle still needs one place that links every meeting page.
 */
const ROOT_INDEX_TITLE = "Knowledge bundle";
const RECENT_MEETING_LIMIT = 10;
const DAY_MS = 86_400_000;
const DUE_SOON_MS = 7 * DAY_MS;

/** Same inline rules as the transcript copy: authored titles are data too. */
const MARKDOWN_SPECIAL = /[\\`*_{}[\]()#+\-.!|<>]/gu;
const LINE_BREAKS = /[\r\n\t\u0000-\u001f\u007f\u2028\u2029]+/gu;

function inlineText(text: string): string {
  return text.replace(LINE_BREAKS, " ").trim().replace(MARKDOWN_SPECIAL, "\\$&");
}

function isoTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function dayStamp(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Bundle-relative link between two page paths, always `./` or `../` prefixed. */
function bundleLink(fromPath: string, toPath: string): string {
  const directory = path.posix.dirname(fromPath);
  const relative = directory === "." ? toPath : path.posix.relative(directory, toPath);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function wholeDays(milliseconds: number): number {
  return Math.ceil(milliseconds / DAY_MS);
}

function pluralDays(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/** Whole-day label from `generatedAtMs`; no `Intl`, no locale, no time zone. */
function relativeDueLabel(dueAtMs: number, nowMs: number): string {
  const remaining = dueAtMs - nowMs;
  if (remaining < 0) return `overdue by ${pluralDays(Math.max(1, wholeDays(-remaining)))}`;
  if (remaining === 0) return "due now";
  return `in ${pluralDays(Math.max(1, wholeDays(remaining)))}`;
}

function dueMarker(dueAtMs: number, nowMs: number): string | undefined {
  if (dueAtMs < nowMs) return "**overdue**";
  if (dueAtMs - nowMs <= DUE_SOON_MS) return "due soon";
  return undefined;
}

function meetingLine(meeting: OkfBundleRow, fromPath: string): string {
  const facts = [
    dayStamp(meeting.startedAtMs),
    meeting.status,
    `${meeting.actionCount} actions`,
    `${meeting.deadlineCount} deadlines`,
  ];
  return `- [${inlineText(meeting.title)}](${bundleLink(fromPath, meeting.relativePath)}) — ${facts.join(" · ")}`;
}

function renderRootIndex(input: OkfRollupInput): string {
  const openActions = input.actions.filter((item) => item.state === "open");
  const openDeadlines = input.deadlines.filter((item) => item.state === "open");
  const overdue = openDeadlines.filter((item) => item.dueAtMs < input.generatedAtMs);
  const recent = [...input.meetings]
    .sort((left, right) => right.startedAtMs - left.startedAtMs
      || compareText(left.relativePath, right.relativePath))
    .slice(0, RECENT_MEETING_LIMIT);
  const body = [
    "# Knowledge bundle",
    "",
    "Committed meeting transcripts ingested from this plugin, together with the",
    "action items and deadlines extracted from them. Every page is Markdown with",
    "YAML frontmatter, and the bundle is versioned with Git.",
    "",
    `Generated ${isoTimestamp(input.generatedAtMs)}.`,
    "",
    "## Counts",
    "",
    `- Meetings: ${input.meetings.length}`,
    `- Open actions: ${openActions.length}`,
    `- Overdue deadlines: ${overdue.length}`,
    "",
    "## Indexes",
    "",
    `- [Meetings](${bundleLink(OKF_ROOT_INDEX, OKF_MEETINGS_INDEX)})`,
    `- [Actions](${bundleLink(OKF_ROOT_INDEX, OKF_ACTIONS_INDEX)})`,
    `- [Deadlines](${bundleLink(OKF_ROOT_INDEX, OKF_DEADLINES_INDEX)})`,
    "",
    "## Recent meetings",
    "",
    ...(recent.length === 0 ? ["None yet."] : recent.map((meeting) => meetingLine(meeting, OKF_ROOT_INDEX))),
  ];
  return renderDocument({
    type: "Index",
    title: ROOT_INDEX_TITLE,
    generated_at: isoTimestamp(input.generatedAtMs),
  }, body.join("\n"));
}

function renderMeetingsIndex(input: OkfRollupInput): string {
  const meetings = [...input.meetings].sort((left, right) => right.startedAtMs - left.startedAtMs
    || compareText(left.relativePath, right.relativePath));
  const body = [
    "# Meetings",
    "",
    "Every ingested meeting, newest first.",
    "",
    ...(meetings.length === 0
      ? ["None yet."]
      : meetings.map((meeting) => meetingLine(meeting, OKF_MEETINGS_INDEX))),
  ];
  return renderDocument({
    type: "Index",
    title: "Meetings",
    generated_at: isoTimestamp(input.generatedAtMs),
  }, body.join("\n"));
}

function compareOpenActions(left: OkfActionItem, right: OkfActionItem): number {
  if (left.dueAtMs !== undefined && right.dueAtMs !== undefined && left.dueAtMs !== right.dueAtMs) {
    return left.dueAtMs - right.dueAtMs;
  }
  if (left.dueAtMs !== undefined && right.dueAtMs === undefined) return -1;
  if (left.dueAtMs === undefined && right.dueAtMs !== undefined) return 1;
  return compareText(left.title, right.title) || compareText(left.id, right.id);
}

function actionLine(item: OkfActionItem, nowMs: number): string {
  const facts: string[] = [];
  if (item.dueAtMs === undefined) {
    facts.push("no due date");
  } else {
    facts.push(`due ${dayStamp(item.dueAtMs)} (${relativeDueLabel(item.dueAtMs, nowMs)})`);
    const marker = dueMarker(item.dueAtMs, nowMs);
    if (marker !== undefined) facts.push(marker);
  }
  if (item.owner !== undefined) facts.push(`owner: ${inlineText(item.owner)}`);
  const target = bundleLink(OKF_ACTIONS_INDEX, actionRelativePath(item));
  return `- [${inlineText(item.title)}](${target}) — ${facts.join(" · ")}`;
}

function renderActionsIndex(input: OkfRollupInput): string {
  const open = input.actions.filter((item) => item.state === "open").sort(compareOpenActions);
  const done = input.actions.filter((item) => item.state === "done").length;
  const dropped = input.actions.filter((item) => item.state === "dropped").length;
  const closed = done + dropped === 0
    ? "None."
    : `${done} done, ${dropped} dropped.`;
  const body = [
    "# Actions",
    "",
    "Open items come first: dated items by due date, then undated items by title.",
    "Closed items are counted only.",
    "",
    "## Open",
    "",
    ...(open.length === 0 ? ["None yet."] : open.map((item) => actionLine(item, input.generatedAtMs))),
    "",
    "## Closed",
    "",
    closed,
  ];
  return renderDocument({
    type: "Index",
    title: "Actions",
    generated_at: isoTimestamp(input.generatedAtMs),
  }, body.join("\n"));
}

function deadlineLine(item: OkfDeadline, nowMs: number): string {
  const owner = item.owner === undefined ? "" : ` · owner: ${inlineText(item.owner)}`;
  return `- **${inlineText(item.title)}** — due ${dayStamp(item.dueAtMs)} `
    + `(${relativeDueLabel(item.dueAtMs, nowMs)})${owner} · meeting ${item.meetingId}`;
}

function renderDeadlinesIndex(input: OkfRollupInput): string {
  const nowMs = input.generatedAtMs;
  const open = input.deadlines.filter((item) => item.state === "open");
  const sorted = [...open].sort((left, right) => left.dueAtMs - right.dueAtMs
    || compareText(left.title, right.title) || compareText(left.id, right.id));
  const overdue = sorted.filter((item) => Number.isFinite(item.dueAtMs) && item.dueAtMs < nowMs);
  const soon = sorted.filter((item) => Number.isFinite(item.dueAtMs)
    && item.dueAtMs >= nowMs && item.dueAtMs - nowMs <= DUE_SOON_MS);
  const later = sorted.filter((item) => Number.isFinite(item.dueAtMs) && item.dueAtMs - nowMs > DUE_SOON_MS);
  const undated = sorted.filter((item) => !Number.isFinite(item.dueAtMs));
  const section = (title: string, items: readonly OkfDeadline[]): readonly string[] => [
    `## ${title}`,
    "",
    ...(items.length === 0 ? ["None yet."] : items.map((item) => deadlineLine(item, nowMs))),
    "",
  ];
  const body = [
    "# Deadlines",
    "",
    `Open deadlines, grouped by how soon they are due at ${isoTimestamp(nowMs)}.`,
    "",
    ...section("Overdue", overdue),
    ...section("Next 7 days", soon),
    ...section("Later", later),
    ...section("No date", undated),
  ];
  return renderDocument({
    type: "Index",
    title: "Deadlines",
    generated_at: isoTimestamp(nowMs),
  }, body.join("\n"));
}

/** Deterministic rollup pages; the caller writes them over the previous set. */
export function renderRollups(input: OkfRollupInput): readonly OkfFile[] {
  return [
    { relativePath: OKF_ROOT_INDEX, content: renderRootIndex(input) },
    { relativePath: OKF_MEETINGS_INDEX, content: renderMeetingsIndex(input) },
    { relativePath: OKF_ACTIONS_INDEX, content: renderActionsIndex(input) },
    { relativePath: OKF_DEADLINES_INDEX, content: renderDeadlinesIndex(input) },
  ];
}
