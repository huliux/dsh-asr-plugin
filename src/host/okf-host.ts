import { randomUUID } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import type { CreateAgentOptions } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { createOkfIngestionRepository } from "../storage/okf-ingestion-repository.js";
import { openMeetingDatabase } from "../storage/database.js";
import type { MeetingRepository } from "../storage/meeting-repository.js";
import {
  createAsrIngestCommand,
  type AsrIngestJob,
  type OkfCommandDefinition,
} from "../okf/asr-ingest-command.js";
import { createOkfBundleLock } from "../okf/bundle-lock.js";
import { OkfError } from "../okf/contracts.js";
import { createOkfGitPort } from "../okf/git-port.js";
import { createOkfGitTransaction } from "../okf/git-transaction.js";
import {
  createOkfIngestionAgent,
  type OkfAgentFactory,
  type OkfAgentHandle,
} from "../okf/ingestion-agent.js";
import {
  createOkfIngestionService,
  type OkfIngestionService,
  type OkfSettings,
} from "../okf/ingestion-service.js";
import { startOkfIngestion, withTranscriptCommitHook } from "../okf/trigger.js";

/** Command runtime as reached through `context.get("commands")`; the package is not installed. */
interface CommandRuntime {
  register(definition: OkfCommandDefinition): unknown;
}

export interface OkfHostOptions {
  readonly databasePath: string;
  /** Unwrapped repository; the host returns a hooked wrapper for the application. */
  readonly repository: MeetingRepository;
  readonly settings: () => OkfSettings;
  readonly meeting: (meetingId: string) => { readonly meetingId: string; readonly title: string } | null;
}

export interface OkfHost {
  /** Repository whose `commitTranscript` starts an automatic ingestion. */
  readonly repository: MeetingRepository;
  readonly service: OkfIngestionService;
  hasCommand: boolean;
  dispose(): Promise<void>;
}

/**
 * `AgentHandle` from the registry wraps the driver; the ingestion agent expects
 * the flattened shape, so this adapter owns the one place that difference lives.
 */
function agentFactory(context: Context): OkfAgentFactory {
  return {
    async create(options: CreateAgentOptions): Promise<OkfAgentHandle> {
      const handle = await context.agents.create(options);
      return {
        followup: (text: string) => handle.agent.followup(createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "user" },
        })),
        whenIdle: () => handle.agent.whenIdle(),
        interrupt: () => handle.agent.cancel({ kind: "parent" }),
        dispose: async () => { await handle.dispose(); },
      };
    },
  };
}

/**
 * Answers "is the okf skill visible here". No plain skill service is installed, so
 * the probe only answers negatively when a reachable service says so; otherwise it
 * stays optimistic, and a genuinely missing skill fails the child, rolls the whole
 * ingestion back and invents nothing.
 */
function skillProbe(context: Context): (name: string) => boolean {
  const service = context.get("skills") as { has?: (name: string) => boolean } | undefined;
  const has = service?.has;
  if (typeof has !== "function") return () => true;
  return (name: string): boolean => {
    try {
      return has.call(service, name);
    } catch {
      return true;
    }
  };
}

function registerCommand(context: Context, definition: OkfCommandDefinition): boolean {
  const runtime = context.get("commands") as CommandRuntime | undefined;
  if (runtime === undefined || typeof runtime.register !== "function") return false;
  try {
    const disposer = runtime.register(definition);
    context.effect(
      () => () => {
        if (typeof disposer === "function") (disposer as () => void)();
      },
      "dsh-asr: /asr-ingest command",
    );
    return true;
  } catch (error) {
    context.logger("dsh-asr").warn(`/asr-ingest could not be registered: ${error instanceof Error ? error.name : "unknown"}`);
    return false;
  }
}

/** Wires the ingestion slices into the running host; call once from `apply`. */
export function installOkfHost(context: Context, options: OkfHostOptions): OkfHost {
  const database = openMeetingDatabase(options.databasePath);
  const attempts = createOkfIngestionRepository(database);
  const service = createOkfIngestionService({
    repository: options.repository,
    attempts,
    git: createOkfGitTransaction(createOkfGitPort(context)),
    lock: createOkfBundleLock(),
    agent: createOkfIngestionAgent({
      agents: agentFactory(context),
      skillAvailable: skillProbe(context),
      sessionId: () => `okf-ingest-${randomUUID()}`,
    }),
    settings: options.settings,
    jobs: context.jobs,
    logger: (line) => { context.logger("dsh-asr").info(line); },
  });
  const repository = withTranscriptCommitHook(options.repository, {
    onCommitted: (meetingId) => { startOkfIngestion(service, options.settings, meetingId); },
  });
  const definition = createAsrIngestCommand({
    directory: () => options.settings().directory,
    // No session-scoped reference is available to a plugin command yet.
    referencedMeetingId: () => null,
    meeting: options.meeting,
    ingest: async (meetingId, ingestOptions): Promise<AsrIngestJob> => {
      const outcome = service.start({ meetingId, force: ingestOptions.force });
      if (outcome.jobId !== null) return { jobId: String(outcome.jobId) };
      if (outcome.kind === "disabled") {
        throw new OkfError(
          "OKF_NOT_CONFIGURED",
          ingestOptions.force
            ? "Choose an Open knowledge base folder in settings first"
            : "Automatic ingestion is switched off; pass --force to ingest anyway",
        );
      }
      throw new OkfError("OKF_AGENT_FAILED", "Open knowledge base ingestion could not start");
    },
  });
  const hasCommand = registerCommand(context, definition);
  void service.recoverStartup().catch((error: unknown) => {
    context.logger("dsh-asr").warn(
      `okf startup recovery failed: ${error instanceof OkfError ? error.code : "unknown"}`,
    );
  });
  return {
    repository,
    service,
    hasCommand,
    async dispose(): Promise<void> {
      database.close();
    },
  };
}
