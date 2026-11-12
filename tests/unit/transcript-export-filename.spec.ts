import { describe, expect, it } from "vitest";

import { transcriptExportFileName, transcriptExportStamp } from "../../src/transcripts/export-filename.js";

const meeting = {
  createdAtMs: Date.parse("2026-11-12T18:09:34.151Z"),
  meetingId: "a4f7e766-928b-4a96-87d7-f81921fddd1c",
  recordingStartedAtMs: Date.parse("2026-11-12T18:09:34.151Z"),
  title: "Recording 2026-11-12T18:09:34.151Z",
};

describe("transcript export naming", () => {
  it("compacts the stamp into a file-system safe ASCII form", () => {
    expect(transcriptExportStamp(meeting.createdAtMs)).toBe("2026-11-12t18-09-34z");
  });

  it("uses a readable slug plus the recording stamp", () => {
    expect(transcriptExportFileName({ ...meeting, title: "Weekly sync" }, "md"))
      .toBe("weekly-sync-2026-11-12t18-09-34z.md");
  });

  it("does not repeat the stamp already present in a title", () => {
    expect(transcriptExportFileName(meeting, "md")).toBe("recording-2026-11-12t18-09-34-151z.md");
  });

  it("falls back to the stamp when the title has no usable characters", () => {
    expect(transcriptExportFileName({ ...meeting, title: "录音会议" }, "md"))
      .toBe("transcript-2026-11-12t18-09-34z.md");
  });

  it("transliterates accents and collapses separators", () => {
    expect(transcriptExportFileName({ ...meeting, title: "  Caffè  Stand-up / #12  " }, "md"))
      .toBe("caffe-stand-up-12-2026-11-12t18-09-34z.md");
  });

  it("keeps every format extension", () => {
    expect(transcriptExportFileName(meeting, "srt")).toMatch(/\.srt$/u);
    expect(transcriptExportFileName(meeting, "vtt")).toMatch(/\.vtt$/u);
    expect(transcriptExportFileName(meeting, "txt")).toMatch(/\.txt$/u);
  });

  it("prefers the recording start over the creation time", () => {
    expect(transcriptExportFileName({
      ...meeting, createdAtMs: Date.parse("2026-01-01T00:00:00.000Z"), title: "Call",
    }, "md")).toBe("call-2026-11-12t18-09-34z.md");
  });
});
