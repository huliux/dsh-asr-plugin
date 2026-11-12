import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { MeetingRecord } from "../storage/types.js";
import { TranscriptProjectionError } from "../transcript-projection/transcript-export-error.js";
import type { ExportCommittedTranscriptInput, TranscriptExportReceipt } from "../transcript-projection/transcript-projection.js";
import { PickerError, type DirectoryPicker } from "./directory-picker.js";
import { transcriptExportFileName } from "./export-filename.js";
import type { TranscriptExportControl, TranscriptExportOutcome, TranscriptExportRequest } from "./transcript-export-contract.js";

export interface TranscriptExportMeetingSource {
  exportTranscript(input: ExportCommittedTranscriptInput): Promise<TranscriptExportReceipt>;
  getMeetingRecord(meetingId: string): MeetingRecord;
}

export interface TranscriptExportControlOptions {
  /** Configured default folder; empty means "not configured yet". */
  readonly directory: () => string;
  readonly meeting: TranscriptExportMeetingSource;
  readonly picker: DirectoryPicker;
  readonly pickerPrompt: () => string;
}

async function requireDirectory(path: string): Promise<string> {
  if (path.trim() === "") {
    throw new TranscriptProjectionError("EXPORT_DIRECTORY_REQUIRED", "Choose a transcript folder first");
  }
  if (!isAbsolute(path)) {
    throw new TranscriptProjectionError("EXPORT_DIRECTORY_INVALID", "Transcript folder must be an absolute path");
  }
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isDirectory()) {
    throw new TranscriptProjectionError("EXPORT_DIRECTORY_INVALID", "Transcript folder does not exist");
  }
  return path;
}

export function createTranscriptExportControl(options: TranscriptExportControlOptions): TranscriptExportControl {
  const chooseDirectory = async (signal?: AbortSignal): Promise<string | null> => {
    try {
      return await options.picker.choose({ prompt: options.pickerPrompt(), ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      if (error instanceof PickerError) {
        if (error.kind === "cancelled") {
          throw new TranscriptProjectionError("CANCELLED_BY_USER", "Folder selection was cancelled");
        }
        throw new TranscriptProjectionError("EXPORT_PICKER_FAILED", "Transcript folder picker failed", { cause: error });
      }
      throw error;
    }
  };

  return {
    chooseDirectory,
    async exportTranscript(request: TranscriptExportRequest, signal): Promise<TranscriptExportOutcome> {
      const meeting = options.meeting.getMeetingRecord(request.meetingId);
      let directory: string;
      if (request.directory !== undefined) {
        directory = request.directory;
      } else if (request.destination === "choose") {
        const chosen = await chooseDirectory(signal);
        if (chosen === null) throw new TranscriptProjectionError("CANCELLED_BY_USER", "Transcript export was cancelled");
        directory = chosen;
      } else {
        directory = options.directory();
      }
      const folder = await requireDirectory(directory);
      const outputPath = join(folder, transcriptExportFileName({
        createdAtMs: meeting.createdAtMs,
        meetingId: meeting.meetingId,
        recordingStartedAtMs: meeting.recordingStartedAtMs,
        title: meeting.title,
      }, request.format));
      const receipt = await options.meeting.exportTranscript({
        format: request.format,
        includeSpeakers: request.includeSpeakers,
        includeTimestamps: request.includeTimestamps,
        meetingId: request.meetingId,
        outputPath,
        overwrite: true,
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        bytes: receipt.bytes,
        format: receipt.format,
        meetingId: receipt.meetingId,
        outputPath: receipt.outputPath,
        segmentCount: receipt.segmentCount,
        transcriptVersion: receipt.transcriptVersion,
      };
    },
  };
}
