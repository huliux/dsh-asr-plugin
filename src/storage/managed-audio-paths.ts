import { join } from "node:path";

import { ManagedAudioError } from "../audio/managed-audio-error.js";
import type { AudioSourceFormat } from "../audio/source-format.js";
import type { MeetingOrigin } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ManagedPaths {
  readonly audioPath: string;
  readonly audioTemporaryPath: string;
  readonly meetingDirectory: string;
  readonly sourcePath: string;
  readonly sourceTemporaryPath: string;
  readonly workDirectory: string;
}

export interface RecordingAudioLayout {
  readonly meetingDirectory: string;
  readonly recordingDirectory: string;
  readonly workRecordingDirectory: string;
}

function assertMeetingId(meetingId: string): void {
  if (!UUID_PATTERN.test(meetingId)) {
    throw new ManagedAudioError("INVALID_PATH", "Meeting id cannot form a managed path");
  }
}

export function managedPaths(
  root: string,
  meetingId: string,
  format: AudioSourceFormat,
): ManagedPaths {
  assertMeetingId(meetingId);
  const meetingDirectory = join(root, "meetings", meetingId);
  const workDirectory = join(root, "work", meetingId);
  return {
    audioPath: join(meetingDirectory, "audio.wav"),
    audioTemporaryPath: join(workDirectory, "audio.tmp.wav"),
    meetingDirectory,
    workDirectory,
    sourcePath: join(meetingDirectory, `source.${format}`),
    sourceTemporaryPath: join(workDirectory, "source.tmp"),
  };
}

export function recordingAudioLayout(root: string, meetingId: string): RecordingAudioLayout {
  assertMeetingId(meetingId);
  const meetingDirectory = join(root, "meetings", meetingId);
  return {
    meetingDirectory,
    recordingDirectory: join(meetingDirectory, "recording"),
    workRecordingDirectory: join(root, "work", meetingId, "recording"),
  };
}

export function managedSourcePath(paths: ManagedPaths, origin: MeetingOrigin): string {
  return origin === "recording" ? paths.audioPath : paths.sourcePath;
}
