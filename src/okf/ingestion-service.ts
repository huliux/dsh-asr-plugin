import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type { JobRegistry } from "@deepseek-ai/dsh-jobs";

import type { MeetingRepository } from "../storage/meeting-repository.js";
import type { OkfIngestionRepository } from "../storage/okf-ingestion-repository.js";
import {
  OkfError,
  type OkfActionItem,
  type OkfAgentPort,
  type OkfBundleRow,
  type OkfDeadline,
  type OkfFile,
  type OkfIngestionRecord,
  type OkfMeetingView,
} from "./contracts.js";
import { parseFrontmatter } from "./frontmatter-read.js";
import type { OkfBundleLock } from "./bundle-lock.js";
import type { OkfGitTransaction } from "./git-transaction.js";
import { buildOkfMeetingView } from "./meeting-view.js";
import { renderRollups } from "./rollups.js";
import { readOkfPages } from "./rollup-read.js";
import { renderTranscriptCopy } from "./transcript-copy.js";
import { transcriptCopyRelativePath } from "./paths.js";
import { scanBundleLinks } from "./link-scan.js";

/** What the settings panel resolves for the plugin at call time. */
export interface OkfSettings {
  readonly directory: string;
  readonly ingest: boolean;
}

export interface OkfIngestionRequest {
  readonly meetingId: string;
  /** Re-ingest even when automatic ingestion is switched off. */
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

export type OkfIngestionOutcomeKind =
  | "ingested"
  | "skill-missing"
  | "disabled"
  | "failed";

export interface OkfIngestionOutcome {
  readonly kind: OkfIngestionOutcomeKind;
  readonly meetingId: string;
  readonly jobId: string | null;
  readonly message: string;
}

export interface OkfIngestionDeps {
  readonly repository: Pick<MeetingRepository, "getMeeting" | "getCommittedTranscriptSnapshot">;
  /** Persists attempts in `okf_ingestion`. */
  readonly attempts: Pick<
    OkfIngestionRepository,
    "beginAttempt" | "finishAttempt" | "findLatestForMeeting"
  >;
  readonly git: OkfGitTransaction;
  readonly lock: OkfBundleLock;
  readonly agent: OkfAgentPort;
  readonly settings: () => OkfSettings;
  /** Job registry handed in by the host. */
  readonly jobs: Pick<JobRegistry, "start">;
  readonly nowMs?: () => number;
  readonly logger?: (line: string) => void;
}

export interface OkfIngestionService {
  /** Fire-and-forget path used by the automatic trigger. */
  start(request: OkfIngestionRequest): OkfIngestionOutcome;
  /** Awaited path used by `/asr-ingest`. */
  run(request: OkfIngestionRequest): Promise<OkfIngestionOutcome>;
  /** Rolls back an ingestion that died mid-flight, if the journal survived a crash. */
  recoverStartup(): Promise<void>;
  state(meetingId: string): OkfIngestionRecord | undefined;
}

declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap { "asr-okf-ingest": "asr-okf-ingest"; }
}

const MAX_BUNDLE_DEPTH = 8;

function requireConfiguredDirectory(settings: OkfSettings): string {
  const directory = settings.directory.trim();
  if (directory === "") {
    throw new OkfError("OKF_NOT_CONFIGURED", "Choose an Open knowledge base folder in settings first");
  }
  return directory;
}

/** Writes bundle-relative content through a sibling temp file and a rename. */
async function writeBundleFile(root: string, file: OkfFile): Promise<void> {
  const target = join(root, ...file.relativePath.split("/"));
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.okf-tmp`;
  try {
    await writeFile(temporary, file.content, { mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readBundlePages(root: string): Promise<readonly OkfFile[]> {
  const pages: OkfFile[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_BUNDLE_DEPTH) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        pages.push({
          relativePath: relative(root, absolute).split(sep).join("/"),
          content: await readFile(absolute, "utf8"),
        });
      }
    }
  };
  await walk(root, 0);
  return pages;
}

interface MeetingPageFields {
  readonly meetingId: string;
  readonly title: string;
  readonly status: "draft" | "stable" | "deprecated";
  readonly startedAtMs: number;
}

function meetingPageFromPage(page: OkfFile): MeetingPageFields | null {
  const { fields } = parseFrontmatter(page.content);
  const meetingId = fields["meeting"] ?? fields["id"];
  if (typeof meetingId !== "string" || meetingId.trim() === "") return null;
  const startedMs = Date.parse(typeof fields["started"] === "string" ? fields["started"] : "");
  const status = fields["status"];
  return {
    meetingId,
    title: typeof fields["title"] === "string" ? fields["title"] : meetingId,
    status: status === "draft" || status === "deprecated" ? status : "stable",
    startedAtMs: Number.isNaN(startedMs) ? 0 : startedMs,
  };
}

function bundleRows(
  pages: readonly OkfFile[],
  actions: readonly OkfActionItem[],
  deadlines: readonly OkfDeadline[],
): readonly OkfBundleRow[] {
  return pages
    .filter((page) => page.relativePath.startsWith("meetings/") && page.relativePath !== "meetings/index.md")
    .flatMap((page) => {
      const meeting = meetingPageFromPage(page);
      if (meeting === null) return [];
      const actionCount = actions.filter((item) =>
        item.sources.some((source) => source.meetingId === meeting.meetingId)).length;
      const deadlineCount = deadlines.filter((deadline) => deadline.meetingId === meeting.meetingId).length;
      return [{
        ...meeting,
        relativePath: page.relativePath,
        actionCount,
        deadlineCount,
      }];
    })
    .sort((left, right) => right.startedAtMs - left.startedAtMs);
}

export function createOkfIngestionService(deps: OkfIngestionDeps): OkfIngestionService {
  const now = deps.nowMs ?? (() => Date.now());

  async function ingestOnce(request: OkfIngestionRequest): Promise<OkfIngestionOutcome> {
    const settings = deps.settings();
    const directory = requireConfiguredDirectory(settings);
    if (settings.ingest !== true && request.force !== true) {
      return {
        kind: "disabled",
        meetingId: request.meetingId,
        jobId: null,
        message: "Automatic ingestion is turned off; run /asr-ingest to ingest this meeting",
      };
    }
    const view: OkfMeetingView = buildOkfMeetingView(deps.repository, request.meetingId);
    const root = await realpath(directory);
    return deps.lock.runExclusive(root, async () => {
      const inspection = await deps.git.inspect(root, request.signal);
      if (!inspection.versioned) {
        throw new OkfError("OKF_NOT_VERSIONED", "The Open knowledge base folder is not a Git repository");
      }
      const interrupted = await deps.git.recoverInterrupted(root, request.signal);
      if (interrupted !== undefined) {
        deps.logger?.(`recovered interrupted OKF ingestion ${interrupted.label}`);
      }
      const startedAtMs = now();
      deps.attempts.beginAttempt({
        meetingId: view.meetingId,
        transcriptVersion: view.transcriptVersion,
        directory: root,
        startedAtMs,
      });
      const session = await deps.git.begin({
        root,
        label: `ingest ${view.meetingId}@v${view.transcriptVersion}`,
        nowMs: startedAtMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      try {
        const copy = renderTranscriptCopy({ meeting: view });
        const existingCopy = await readFile(join(root, ...copy.relativePath.split("/")), "utf8").catch(() => null);
        if (existingCopy !== copy.content) await writeBundleFile(root, copy);

        const outcome = await deps.agent.ingest({
          directory: root,
          meeting: view,
          transcriptCopyPath: transcriptCopyRelativePath(view.meetingId),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        if (outcome.kind === "failed") {
          throw new OkfError("OKF_AGENT_FAILED", outcome.message ?? "The summarising agent failed");
        }

        const agentPages = await readBundlePages(root);
        const items = readOkfPages(agentPages);
        const rows = bundleRows(agentPages, items.actions, items.deadlines);
        const rollups = renderRollups({
          generatedAtMs: now(),
          meetings: rows,
          actions: items.actions,
          deadlines: items.deadlines,
        });
        for (const rollup of rollups) await writeBundleFile(root, rollup);

        const allPages = [...agentPages.filter((page) => !rollups.some((rollup) => rollup.relativePath === page.relativePath)), ...rollups];
        const violations = scanBundleLinks({
          files: allPages,
          existingPaths: allPages.map((page) => page.relativePath),
        });
        if (violations.length > 0) {
          throw new OkfError("OKF_LINK_OUTSIDE_BUNDLE", `${violations.length} link(s) leave the Open knowledge base`);
        }

        const committed = await session.commit();
        deps.attempts.finishAttempt({
          meetingId: view.meetingId,
          transcriptVersion: view.transcriptVersion,
          directory: root,
          state: "succeeded",
          finishedAtMs: now(),
        });
        return {
          kind: outcome.kind,
          meetingId: view.meetingId,
          jobId: null,
          message: `Ingested ${view.meetingId}@v${view.transcriptVersion} as ${committed.commit.slice(0, 12)}`,
        };
      } catch (error) {
        await session.rollback().catch(() => undefined);
        const code = error instanceof OkfError ? error.code : "OKF_GIT_FAILED";
        deps.attempts.finishAttempt({
          meetingId: view.meetingId,
          transcriptVersion: view.transcriptVersion,
          directory: root,
          state: "failed",
          finishedAtMs: now(),
          errorCode: code,
          errorMessage: error instanceof OkfError ? error.message.slice(0, 200) : "Ingestion failed",
        });
        throw error instanceof OkfError
          ? error
          : new OkfError("OKF_GIT_FAILED", "Ingestion failed and was rolled back", { cause: error });
      }
    });
  }

  return {
    start(request): OkfIngestionOutcome {
      const settings = deps.settings();
      if (settings.directory.trim() === "" || (settings.ingest !== true && request.force !== true)) {
        return {
          kind: settings.directory.trim() === "" ? "disabled" : "disabled",
          meetingId: request.meetingId,
          jobId: null,
          message: "OKF ingestion skipped",
        };
      }
      let resolveDone: (value: OkfIngestionOutcome) => void = () => undefined;
      const done = new Promise<OkfIngestionOutcome>((resolve) => { resolveDone = resolve; });
      const controller = new AbortController();
      const id = deps.jobs.start({
        kind: "asr-okf-ingest",
        label: `Summarise meeting into Open knowledge base`,
        run: (job) => {
          job.updateProgress("summarising");
          void ingestOnce({ ...request, signal: controller.signal })
            .then(resolveDone)
            .catch(() => resolveDone({
              kind: "failed",
              meetingId: request.meetingId,
              jobId: String(job.id),
              message: "Ingestion failed and was rolled back",
            }));
          return {
            cancel: () => controller.abort(),
            done: done.then((outcome) => ({
              status: outcome.kind === "failed" ? "failed" as const : "completed" as const,
              ...(outcome.kind === "failed" ? { detail: outcome.message } : {}),
            })),
          };
        },
      });
      return {
        kind: "disabled",
        meetingId: request.meetingId,
        jobId: String(id),
        message: "Ingestion started",
      };
    },
    async run(request): Promise<OkfIngestionOutcome> {
      return ingestOnce(request);
    },
    async recoverStartup(): Promise<void> {
      const settings = deps.settings();
      if (settings.directory.trim() === "") return;
      const root = await realpath(settings.directory).catch(() => null);
      if (root === null) return;
      const interrupted = await deps.git.recoverInterrupted(root).catch(() => undefined);
      if (interrupted !== undefined) {
        deps.logger?.(`recovered interrupted OKF ingestion ${interrupted.label}`);
      }
    },
    state(meetingId: string): OkfIngestionRecord | undefined {
      return deps.attempts.findLatestForMeeting(meetingId);
    },
  };
}

/** Exposed for tests: absolute path of a bundle-relative page. */
export function bundleAbsolutePath(root: string, relativePath: string): string {
  return join(root, ...relativePath.split("/"));
}

/** Exposed for tests: whether the folder exists as a directory. */
export async function bundleRootExists(root: string): Promise<boolean> {
  const info = await stat(root).catch(() => null);
  return info?.isDirectory() ?? false;
}
