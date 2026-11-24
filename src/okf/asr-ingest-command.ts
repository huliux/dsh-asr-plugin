import { OkfError } from "./contracts.js";

/** Slash command that ingests one committed meeting into the OKF bundle. */
export const ASR_INGEST_COMMAND_NAME = "asr-ingest";

/** Returned when the bundle folder is not configured yet. */
export const OKF_DIRECTORY_REQUIRED_MESSAGE = "Choose an Open knowledge base folder in settings first";

export interface AsrIngestMeeting {
  readonly meetingId: string;
  readonly title: string;
}

export interface AsrIngestJob {
  readonly jobId: string;
}

export interface AsrIngestCommandDeps {
  /** Configured bundle folder; empty means the feature is not set up. */
  readonly directory: () => string;
  /** Meeting the command was invoked from, if the runtime supplies one. */
  readonly referencedMeetingId: () => string | null;
  readonly meeting: (meetingId: string) => AsrIngestMeeting | null;
  readonly ingest: (meetingId: string, options: { readonly force: boolean }) => Promise<AsrIngestJob>;
}

export type AsrIngestCommandResult =
  | { readonly kind: "success"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

/**
 * Structural copy of the host command runtime shape. `@deepseek-ai/dsh-commands`
 * is not part of this package's installed toolchain, so the host registers this
 * object through `context.get("commands")` and only these fields are relied on.
 */
export interface OkfCommandDefinition {
  readonly name: typeof ASR_INGEST_COMMAND_NAME;
  readonly description: string;
  readonly input?: { readonly hint: string };
  readonly handler: (input: { readonly args: string }) => Promise<AsrIngestCommandResult>;
}

export type ParsedAsrIngestArgs =
  | { readonly kind: "ok"; readonly meetingId: string | null; readonly force: boolean }
  | { readonly kind: "error"; readonly message: string };

/**
 * Parse `<meeting-id> [--force]`. A bare `--force` leaves the meeting null so
 * the handler can fall back to the meeting the command was invoked from.
 */
export function parseAsrIngestArgs(args: string): ParsedAsrIngestArgs {
  let meetingId: string | null = null;
  let force = false;
  const tokens = args.trim().split(/\s+/u).filter(token => token !== "");
  for (const token of tokens) {
    if (token === "--force") {
      if (force) return { kind: "error", message: "Pass --force only once." };
      force = true;
      continue;
    }
    if (token.startsWith("-")) return { kind: "error", message: `Unknown option ${token}.` };
    if (meetingId !== null) return { kind: "error", message: "Pass exactly one meeting id." };
    meetingId = token;
  }
  return { kind: "ok", meetingId, force };
}

function jobText(meeting: AsrIngestMeeting, job: AsrIngestJob): string {
  const title = meeting.title.replace(/\s+/gu, " ").trim();
  const name = title === "" ? meeting.meetingId : `"${title}" (${meeting.meetingId})`;
  return `Ingestion of ${name} started as job ${job.jobId}.`;
}

function failureText(error: unknown): string {
  if (!(error instanceof OkfError)) return "Open knowledge base ingestion failed.";
  switch (error.code) {
    case "OKF_NOT_CONFIGURED":
      return OKF_DIRECTORY_REQUIRED_MESSAGE;
    case "OKF_BUSY":
      return "Another ingestion is already running. Try again when it finishes.";
    case "CANCELLED_BY_USER":
      return "Open knowledge base ingestion was cancelled.";
    case "OKF_AGENT_FAILED":
      return "The Open knowledge base writer failed.";
    case "OKF_GIT_FAILED":
      return "The Open knowledge base commit failed.";
    default:
      return `Open knowledge base ingestion failed (${error.code}).`;
  }
}

export function createAsrIngestCommand(deps: AsrIngestCommandDeps): OkfCommandDefinition {
  return {
    name: ASR_INGEST_COMMAND_NAME,
    description: "Ingest a committed meeting transcript into the Open knowledge base",
    input: { hint: "<meeting-id> [--force]" },
    async handler({ args }): Promise<AsrIngestCommandResult> {
      const parsed = parseAsrIngestArgs(args);
      if (parsed.kind === "error") return { kind: "error", text: parsed.message };

      let directory: string;
      try {
        directory = deps.directory();
      } catch {
        return { kind: "error", text: OKF_DIRECTORY_REQUIRED_MESSAGE };
      }
      if (directory.trim() === "") return { kind: "error", text: OKF_DIRECTORY_REQUIRED_MESSAGE };

      let referenced: string | null;
      try {
        referenced = deps.referencedMeetingId();
      } catch {
        referenced = null;
      }
      const meetingId = parsed.meetingId ?? referenced;
      if (meetingId === null || meetingId.trim() === "") {
        return { kind: "error", text: "Pass a meeting id, or run this command from a meeting." };
      }

      let meeting: AsrIngestMeeting | null;
      try {
        meeting = deps.meeting(meetingId);
      } catch {
        return { kind: "error", text: `Meeting ${meetingId} was not found.` };
      }
      if (meeting === null) return { kind: "error", text: `Meeting ${meetingId} was not found.` };

      try {
        const job = await deps.ingest(meeting.meetingId, { force: parsed.force });
        return { kind: "success", text: jobText(meeting, job) };
      } catch (error) {
        return { kind: "error", text: failureText(error) };
      }
    },
  };
}
