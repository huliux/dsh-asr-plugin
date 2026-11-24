/**
 * Shared vocabulary for Open Knowledge Format (OKF) ingestion.
 *
 * Every module under `src/okf` implements one slice of this contract. The file
 * holds data shapes, ports and error codes only: no behaviour, no imports from
 * sibling modules, so the slices stay independently replaceable.
 */

/** Stable error codes surfaced to tools, commands and the settings panel. */
export type OkfErrorCode =
  | "OKF_NOT_CONFIGURED"
  | "OKF_INVALID_DIRECTORY"
  | "OKF_NOT_VERSIONED"
  | "OKF_PATH_ESCAPE"
  | "OKF_LINK_OUTSIDE_BUNDLE"
  | "OKF_AGENT_FAILED"
  | "OKF_GIT_FAILED"
  | "OKF_BUSY"
  | "OKF_JOURNAL_UNCLOSED"
  | "CANCELLED_BY_USER";

export class OkfError extends Error {
  readonly code: OkfErrorCode;

  constructor(code: OkfErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OkfError";
    this.code = code;
  }
}

/** Lifecycle of one ingestion attempt, persisted in `okf_ingestion`. */
export type OkfIngestionState = "running" | "succeeded" | "failed";

export interface OkfIngestionRecord {
  readonly meetingId: string;
  readonly transcriptVersion: number;
  /** Absolute bundle root the attempt wrote to. */
  readonly directory: string;
  readonly state: OkfIngestionState;
  readonly attempt: number;
  readonly startedAtMs: number;
  readonly finishedAtMs?: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/** One committed transcript segment as the bundle sees it. */
export interface OkfSegmentView {
  readonly seq: number;
  readonly speaker: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/** Immutable snapshot of a committed transcript version. */
export interface OkfMeetingView {
  readonly meetingId: string;
  readonly title: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
  /** Display names in first-appearance order, deduplicated. */
  readonly speakers: readonly string[];
  readonly transcriptVersion: number;
  readonly committedAtMs: number;
  /** True while the transcript is still being appended to (draft recording). */
  readonly partial: boolean;
  readonly segments: readonly OkfSegmentView[];
}

/** One file the plugin writes into the bundle, addressed from the bundle root. */
export interface OkfFile {
  readonly relativePath: string;
  readonly content: string;
}

export interface OkfSourceRef {
  readonly meetingId: string;
  readonly transcriptVersion: number;
  /** Segment offset in ms, when the source is a point in the transcript. */
  readonly atMs?: number;
}

export type OkfActionState = "open" | "done" | "dropped";

export interface OkfActionItem {
  readonly id: string;
  readonly title: string;
  readonly state: OkfActionState;
  readonly owner?: string;
  /** Epoch milliseconds; `undefined` when the item carries no deadline. */
  readonly dueAtMs?: number;
  readonly sources: readonly OkfSourceRef[];
}

export interface OkfDeadline {
  readonly id: string;
  readonly title: string;
  readonly dueAtMs: number;
  readonly state: OkfActionState;
  readonly owner?: string;
  readonly meetingId: string;
}

export interface OkfBundleRow {
  readonly meetingId: string;
  readonly title: string;
  readonly relativePath: string;
  readonly startedAtMs: number;
  readonly status: "draft" | "stable" | "deprecated";
  readonly actionCount: number;
  readonly deadlineCount: number;
}

/** Everything the rollups need; assembled by the orchestrator from SQLite. */
export interface OkfRollupInput {
  readonly generatedAtMs: number;
  readonly meetings: readonly OkfBundleRow[];
  readonly actions: readonly OkfActionItem[];
  readonly deadlines: readonly OkfDeadline[];
}

export type OkfLinkViolationReason = "outside-bundle" | "missing-target";

export interface OkfLinkViolation {
  readonly relativePath: string;
  /** 1-based line number inside `relativePath`. */
  readonly line: number;
  readonly target: string;
  readonly reason: OkfLinkViolationReason;
}

/** Result of one `git` invocation, captured for diagnostics without its content. */
export interface OkfGitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** `git` is always invoked through this port with an argv array, never a shell. */
export interface OkfGitPort {
  run(
    argv: readonly string[],
    options: { readonly cwd: string; readonly signal?: AbortSignal },
  ): Promise<OkfGitResult>;
}

export interface OkfAgentRequest {
  /** Bundle root; the child workspace is exactly this directory. */
  readonly directory: string;
  readonly meeting: OkfMeetingView;
  /** Bundle-relative path of the transcript copy the plugin already wrote. */
  readonly transcriptCopyPath: string;
  readonly signal?: AbortSignal;
}

export interface OkfAgentOutcome {
  /** `skill-missing`: the okf skill was unavailable, so only copy + indexes exist. */
  readonly kind: "ingested" | "skill-missing" | "failed";
  readonly message?: string;
}

export interface OkfAgentPort {
  ingest(request: OkfAgentRequest): Promise<OkfAgentOutcome>;
}
