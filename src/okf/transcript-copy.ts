import type { OkfFile, OkfMeetingView, OkfSegmentView } from "./contracts.js";
import { renderDocument } from "./frontmatter.js";
import { transcriptCopyRelativePath } from "./paths.js";

/**
 * Defence in depth for meeting content.
 *
 * Speaker names and segment text are untrusted input: they come from ASR and
 * may contain anything a recording picked up, including prompt-injection text
 * aimed at the child agent that later reads the bundle. The copy is written as
 * Markdown, so every character that can start an inline construct is
 * backslash-escaped: emphasis, code, headings, lists and HTML.
 *
 * Escaping `[`, `]`, `(`, `)` and `<` additionally stops transcript text from
 * turning into a link, an image, an autolink or an embed, which would both
 * distort the page and let transcript content point the agent at other URLs.
 * Line breaks are flattened first so a segment can never open a new block
 * (a second heading, a table or an HTML block) on the page.
 */
const MARKDOWN_SPECIAL = /[\\`*_{}[\]()#+\-.!|<>]/gu;
const LINE_BREAKS = /[\r\n\t\u0000-\u001f\u007f\u2028\u2029]+/gu;

/** Flatten to one line and escape every Markdown-significant character. */
export function escapeMarkdownInline(text: string): string {
  return text.replace(LINE_BREAKS, " ").trim().replace(MARKDOWN_SPECIAL, "\\$&");
}

function formatClock(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function isoTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function renderSummary(meeting: OkfMeetingView): string {
  const participants = meeting.speakers.length === 0
    ? "none identified"
    : meeting.speakers.map(escapeMarkdownInline).join(", ");
  const duration = formatDuration(dimension(meeting.durationMs));
  const segments = meeting.segments.length;
  return `Participants: ${participants}. Duration: ${duration}. `
    + `Segments: ${segments} (transcript version ${dimension(meeting.transcriptVersion)}).`;
}

function renderSegmentLine(segment: OkfSegmentView): string {
  const speaker = escapeMarkdownInline(segment.speaker) || "Unknown speaker";
  const text = escapeMarkdownInline(segment.text);
  return `[${formatClock(dimension(segment.startMs))}] **${speaker}:** ${text}`;
}

/**
 * One committed transcript version as a stable Markdown page.
 *
 * The page is a pure function of the meeting snapshot: no clock, no locale, no
 * random id, so re-ingesting the same version rewrites identical bytes.
 */
export function renderTranscriptCopy(input: { readonly meeting: OkfMeetingView }): OkfFile {
  const { meeting } = input;
  const body = [
    `# ${escapeMarkdownInline(meeting.title) || "Untitled meeting"}`,
    "",
    renderSummary(meeting),
    "",
    ...(meeting.segments.length === 0
      ? ["No segments were committed for this transcript version."]
      : meeting.segments.map(renderSegmentLine)),
  ].join("\n");
  return {
    relativePath: transcriptCopyRelativePath(meeting.meetingId),
    content: renderDocument({
      type: "Transcript",
      title: meeting.title,
      meeting_id: meeting.meetingId,
      transcript_version: dimension(meeting.transcriptVersion),
      started_at: isoTimestamp(meeting.startedAtMs),
      committed_at: isoTimestamp(meeting.committedAtMs),
      duration_ms: dimension(meeting.durationMs),
      participants: meeting.speakers,
      status: meeting.partial ? "draft" : "stable",
      sources: [meeting.meetingId],
    }, body),
  };
}
