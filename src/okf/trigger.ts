import type { MeetingRepository } from "../storage/meeting-repository.js";
import type { OkfIngestionService } from "./ingestion-service.js";

export interface TranscriptCommitHook {
  /** Called once a transcript version is committed and readable. */
  readonly onCommitted: (meetingId: string, transcriptVersion: number) => void;
}

/**
 * Both import and retranscription funnel through `commitTranscript`, so one
 * interception covers every committed version while drafts, cancelled
 * recordings and failed runs never reach the hook at all.
 */
export function withTranscriptCommitHook(
  repository: MeetingRepository,
  hook: TranscriptCommitHook,
): MeetingRepository {
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "commitTranscript") {
        return (input: Parameters<MeetingRepository["commitTranscript"]>[0]) => {
          const result = target.commitTranscript(input);
          try {
            if (result.outcome === "committed") {
              hook.onCommitted(result.meeting.meetingId, result.meeting.transcriptVersion);
            }
          } catch {
            // A failed hand-off must never fail the transcript commit itself.
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export interface StartOkfIngestionOptions {
  readonly settings: () => { readonly directory: string; readonly ingest: boolean };
  /**
   * Committed status of the version that just landed. An empty transcript has
   * nothing to summarise, so it must not start a job that can only fail.
   */
  readonly committedStatus?: "completed" | "empty" | "partial";
}

/** Starts ingestion for a committed version when the settings allow it. */
export function startOkfIngestion(
  service: OkfIngestionService,
  options: StartOkfIngestionOptions,
  meetingId: string,
): void {
  if (options.committedStatus === "empty") return;
  const current = options.settings();
  if (current.directory.trim() === "" || current.ingest !== true) return;
  service.start({ meetingId, skipIfSucceeded: true });
}
