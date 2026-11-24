import { describe, expect, it } from "vitest";

import type { OkfMeetingView } from "../../src/okf/contracts.js";
import { renderTranscriptCopy } from "../../src/okf/transcript-copy.js";

function lines(...items: readonly string[]): string {
  return `${items.join("\n")}\n`;
}

const MEETING: OkfMeetingView = {
  meetingId: "11111111-1111-4111-8111-111111111111",
  title: "Weekly product sync",
  startedAtMs: Date.parse("2026-11-20T09:00:00.000Z"),
  durationMs: 3_723_000,
  speakers: ["Alice", "Bob: the builder"],
  transcriptVersion: 2,
  committedAtMs: Date.parse("2026-11-20T09:10:00.000Z"),
  partial: true,
  segments: [
    {
      seq: 0,
      speaker: "Alice",
      startMs: 0,
      endMs: 2_000,
      text: "Hello [click](https://evil.example), ![x](y.png), **bold**, <script>alert(1)</script>",
    },
    {
      seq: 1,
      speaker: "Eve] (https://evil)",
      startMs: 3_723_000,
      endMs: 3_725_000,
      text: "line one\n\n# Injected heading\n\n[a](b)",
    },
  ],
};

describe("renderTranscriptCopy", () => {
  it("renders the whole page deterministically", () => {
    const file = renderTranscriptCopy({ meeting: MEETING });
    expect(file.relativePath).toBe("references/transcripts/11111111-1111-4111-8111-111111111111.md");
    expect(file.content).toBe(lines(
      "---",
      "type: Transcript",
      "title: Weekly product sync",
      "meeting_id: 11111111-1111-4111-8111-111111111111",
      "transcript_version: 2",
      'started_at: "2026-11-20T09:00:00.000Z"',
      'committed_at: "2026-11-20T09:10:00.000Z"',
      "duration_ms: 3723000",
      'participants: [Alice, "Bob: the builder"]',
      "status: draft",
      "sources: [11111111-1111-4111-8111-111111111111]",
      "---",
      "",
      "# Weekly product sync",
      "",
      "Participants: Alice, Bob: the builder. Duration: 1h 2m 3s. Segments: 2 (transcript version 2).",
      "",
      "[00:00:00] **Alice:** Hello \\[click\\]\\(https://evil\\.example\\), \\!\\[x\\]\\(y\\.png\\), \\*\\*bold\\*\\*, \\<script\\>alert\\(1\\)\\</script\\>",
      "[01:02:03] **Eve\\] \\(https://evil\\):** line one \\# Injected heading \\[a\\]\\(b\\)",
    ));
  });

  it("produces identical bytes for identical snapshots", () => {
    expect(renderTranscriptCopy({ meeting: MEETING }).content)
      .toBe(renderTranscriptCopy({ meeting: structuredClone(MEETING) }).content);
  });

  it("never leaves an unescaped inline link or image in the body", () => {
    const body = renderTranscriptCopy({ meeting: MEETING }).content;
    expect(body).not.toMatch(/(?<!\\)\]\(/u);
    expect(body).not.toMatch(/^<[a-z]/imu);
  });

  it("keeps transcript line breaks from starting a new block", () => {
    const body = renderTranscriptCopy({ meeting: MEETING }).content;
    const headings = body.split("\n").filter((line) => line.startsWith("#"));
    expect(headings).toEqual(["# Weekly product sync"]);
  });

  it("floors timestamps to whole seconds", () => {
    const file = renderTranscriptCopy({
      meeting: {
        ...MEETING,
        segments: [{ seq: 0, speaker: "Alice", startMs: 3_723_999, endMs: 3_724_000, text: "later" }],
      },
    });
    expect(file.content).toContain("[01:02:03] **Alice:** later");
  });

  it("marks a committed version as stable", () => {
    const file = renderTranscriptCopy({ meeting: { ...MEETING, partial: false } });
    expect(file.content).toContain("\nstatus: stable\n");
  });

  it("renders an empty transcript without inventing segments", () => {
    const file = renderTranscriptCopy({ meeting: { ...MEETING, segments: [] } });
    expect(file.content).toContain("Segments: 0 (transcript version 2).");
    expect(file.content).toContain("No segments were committed for this transcript version.");
  });

  it("does not repeat the escaped speaker inside the page body twice", () => {
    const file = renderTranscriptCopy({ meeting: MEETING });
    const occurrences = file.content.split("Eve\\] \\(https://evil\\)").length - 1;
    expect(occurrences).toBe(1);
  });

  it.each([
    [3_723_000, "1h 2m 3s"],
    [3_600_000, "1h 0m 0s"],
    [90_000, "1m 30s"],
    [45_000, "45s"],
    [0, "0s"],
  ])("formats %i ms as %s", (durationMs, expected) => {
    const file = renderTranscriptCopy({ meeting: { ...MEETING, durationMs } });
    expect(file.content).toContain(`Duration: ${expected}.`);
  });

  it("names the absence of speakers instead of leaving the summary dangling", () => {
    const file = renderTranscriptCopy({ meeting: { ...MEETING, speakers: [] } });
    expect(file.content).toContain("Participants: none identified.");
    expect(file.content).toContain("\nparticipants: []\n");
  });

  it("falls back to a placeholder heading when the title is only whitespace", () => {
    const file = renderTranscriptCopy({ meeting: { ...MEETING, title: "   " } });
    expect(file.content).toContain("\n# Untitled meeting\n");
    expect(file.content).toContain("meeting_id: 11111111-1111-4111-8111-111111111111");
  });
});
