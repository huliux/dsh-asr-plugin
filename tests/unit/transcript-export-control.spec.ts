import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { MeetingRecord } from "../../src/storage/types.js";
import type { ExportCommittedTranscriptInput, TranscriptExportReceipt } from "../../src/transcript-projection/transcript-projection.js";
import type { DirectoryPicker } from "../../src/transcripts/directory-picker.js";
import { createTranscriptExportControl } from "../../src/transcripts/transcript-export-control.js";

const MEETING_ID = "a4f7e766-928b-4a96-87d7-f81921fddd1c";
const meeting: MeetingRecord = {
  activeRunId: null, committedStatus: "completed", createdAtMs: Date.parse("2026-11-12T18:09:34.151Z"),
  durationMs: 67_745, engineFingerprint: "b".repeat(64), errorCode: null, errorStage: null,
  meetingId: MEETING_ID, origin: "recording", recordingEndedAtMs: null, recordingStartedAtMs: null,
  resultReason: null, runIdentity: null, runKind: null, sourceFormat: "wav", sourceName: "audio.wav",
  sourceSha256: null, sourceSizeBytes: null, status: "completed", title: "Weekly sync",
  transcriptIdentity: null, transcriptVersion: 1, updatedAtMs: 0,
} as unknown as MeetingRecord;

interface Harness {
  readonly exported: ExportCommittedTranscriptInput[];
  readonly source: {
    exportTranscript(input: ExportCommittedTranscriptInput): Promise<TranscriptExportReceipt>;
    getMeetingRecord(meetingId: string): MeetingRecord;
  };
}

function harness(): Harness {
  const exported: ExportCommittedTranscriptInput[] = [];
  return {
    exported,
    source: {
      async exportTranscript(input) {
        exported.push(input);
        const body = "# Meeting transcript\n";
        await writeFile(input.outputPath, body, "utf8");
        return {
          bytes: Buffer.byteLength(body), durationMs: 1, format: input.format, meetingId: input.meetingId,
          outputPath: input.outputPath, overwritten: true, segmentCount: 3, sha256: "c".repeat(64),
          transcriptVersion: 1,
        };
      },
      getMeetingRecord(meetingId) {
        if (meetingId !== MEETING_ID) throw Object.assign(new Error("missing"), { code: "MEETING_NOT_FOUND" });
        return meeting;
      },
    },
  };
}

const picker = (result: string | null): DirectoryPicker => ({ choose: async () => result });

const roots: string[] = [];

async function folder(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "dsh-asr-transcripts-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("transcript export control", () => {
  it("writes into the configured folder with a stamped Markdown name", async () => {
    const directory = await folder();
    const test = harness();
    const control = createTranscriptExportControl({
      directory: () => directory, meeting: test.source, picker: picker(null), pickerPrompt: () => "Pick",
    });
    const outcome = await control.exportTranscript({
      destination: "default", format: "md", includeSpeakers: true, includeTimestamps: true, meetingId: MEETING_ID,
    });
    expect(outcome.outputPath).toBe(join(directory, "weekly-sync-2026-11-12t18-09-34z.md"));
    expect(outcome.segmentCount).toBe(3);
    expect(test.exported[0]).toMatchObject({
      includeSpeakers: true, includeTimestamps: true, meetingId: MEETING_ID, overwrite: true,
    });
    expect(await readFile(outcome.outputPath, "utf8")).toContain("# Meeting transcript");
  });

  it("asks for a folder when none is configured", async () => {
    const test = harness();
    const control = createTranscriptExportControl({
      directory: () => "  ", meeting: test.source, picker: picker(null), pickerPrompt: () => "Pick",
    });
    await expect(control.exportTranscript({
      destination: "default", format: "md", includeSpeakers: false, includeTimestamps: false, meetingId: MEETING_ID,
    })).rejects.toMatchObject({ code: "EXPORT_DIRECTORY_REQUIRED" });
    expect(test.exported).toHaveLength(0);
  });

  it("rejects relative and missing folders", async () => {
    const test = harness();
    const relative = createTranscriptExportControl({
      directory: () => "Documents/transcripts", meeting: test.source, picker: picker(null), pickerPrompt: () => "Pick",
    });
    await expect(relative.exportTranscript({
      destination: "default", format: "md", includeSpeakers: false, includeTimestamps: false, meetingId: MEETING_ID,
    })).rejects.toMatchObject({ code: "EXPORT_DIRECTORY_INVALID" });
    const missing = createTranscriptExportControl({
      directory: () => "/tmp/dsh-asr-does-not-exist/transcripts",
      meeting: test.source, picker: picker(null), pickerPrompt: () => "Pick",
    });
    await expect(missing.exportTranscript({
      destination: "default", format: "md", includeSpeakers: false, includeTimestamps: false, meetingId: MEETING_ID,
    })).rejects.toMatchObject({ code: "EXPORT_DIRECTORY_INVALID" });
  });

  it("uses the picked folder for choose destination and an explicit directory override", async () => {
    const chosen = await folder();
    const override = await folder();
    const test = harness();
    const control = createTranscriptExportControl({
      directory: () => "", meeting: test.source, picker: picker(chosen), pickerPrompt: () => "Pick",
    });
    const picked = await control.exportTranscript({
      destination: "choose", format: "md", includeSpeakers: false, includeTimestamps: false, meetingId: MEETING_ID,
    });
    expect(picked.outputPath).toBe(join(chosen, "weekly-sync-2026-11-12t18-09-34z.md"));
    const explicit = await control.exportTranscript({
      destination: "default", directory: override, format: "txt",
      includeSpeakers: false, includeTimestamps: false, meetingId: MEETING_ID,
    });
    expect(explicit.format).toBe("txt");
    expect(explicit.outputPath).toBe(join(override, "weekly-sync-2026-11-12t18-09-34z.txt"));
  });

  it("maps a cancelled dialog to CANCELLED_BY_USER", async () => {
    const test = harness();
    const control = createTranscriptExportControl({
      directory: () => "", meeting: test.source, picker: picker(null), pickerPrompt: () => "Pick",
    });
    await expect(control.chooseDirectory()).resolves.toBeNull();
    await expect(control.exportTranscript({
      destination: "choose", format: "md", includeSpeakers: false, includeTimestamps: false, meetingId: MEETING_ID,
    })).rejects.toMatchObject({ code: "CANCELLED_BY_USER" });
  });

  it("surfaces an unknown meeting as the repository error", async () => {
    const test = harness();
    const control = createTranscriptExportControl({
      directory: () => "", meeting: test.source, picker: picker(null), pickerPrompt: () => "Pick",
    });
    await expect(control.exportTranscript({
      destination: "default", format: "md", includeSpeakers: false, includeTimestamps: false,
      meetingId: "11111111-1111-4111-8111-111111111111",
    })).rejects.toMatchObject({ code: "MEETING_NOT_FOUND" });
  });
});
