import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { JobId, type JobRegistry } from "@deepseek-ai/dsh-jobs";
import { afterEach, describe, expect, it } from "vitest";

import { createOkfBundleLock } from "../../src/okf/bundle-lock.js";
import {
  OkfError,
  type OkfAgentOutcome,
  type OkfAgentPort,
  type OkfAgentRequest,
  type OkfFile,
} from "../../src/okf/contracts.js";
import {
  OKF_INGESTION_JOURNAL_FILE,
  createOkfGitTransaction,
} from "../../src/okf/git-transaction.js";
import {
  createOkfIngestionService,
  type OkfIngestionService,
  type OkfSettings,
} from "../../src/okf/ingestion-service.js";
import {
  OKF_ACTIONS_INDEX,
  OKF_DEADLINES_INDEX,
  OKF_MEETINGS_INDEX,
  OKF_ROOT_INDEX,
  meetingRelativePath,
  transcriptCopyRelativePath,
} from "../../src/okf/paths.js";
import { openMeetingDatabase } from "../../src/storage/database.js";
import {
  openMeetingRepository,
  type MeetingRepository,
} from "../../src/storage/meeting-repository.js";
import {
  createOkfIngestionRepository,
  type OkfIngestionRepository,
} from "../../src/storage/okf-ingestion-repository.js";
import {
  createRealGitPort,
  createTemporaryRoot,
  gitAvailable,
  gitText,
  hashTree,
} from "../helpers/okf-git.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const IMPORT_RUN_ID = "22222222-2222-4222-8222-222222222222";
const STARTED_AT_MS = Date.parse("2026-11-20T09:00:00.000Z");
const COMMITTED_AT_MS = STARTED_AT_MS + 60_000;
const CLOCK_START_MS = Date.parse("2026-11-24T12:00:00.000Z");
const MEETING_PAGE = "meetings/2026-11-20-weekly-planning.md";

const realPort = createRealGitPort();
const transaction = createOkfGitTransaction(realPort);
const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    try {
      close();
    } catch {
      // Cleanup is best-effort: the original assertion failure is more useful.
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await createTemporaryRoot("dsh-asr-okf-ingestion-service-");
  roots.push(root);
  return root;
}

function journalPath(root: string): string {
  return join(root, ".git", OKF_INGESTION_JOURNAL_FILE);
}

function bundlePath(root: string, relativePath: string): string {
  return join(root, ...relativePath.split("/"));
}

async function git(root: string, argv: readonly string[]): Promise<string> {
  return await gitText(realPort, argv, root);
}

async function headSha(root: string): Promise<string> {
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

async function lastSubject(root: string): Promise<string> {
  return (await git(root, ["log", "-1", "--format=%s"])).trim();
}

async function commitCount(root: string): Promise<number> {
  return Number.parseInt((await git(root, ["rev-list", "--count", "HEAD"])).trim(), 10);
}

async function statusPorcelain(root: string): Promise<string> {
  return (await git(root, ["status", "--porcelain"])).trim();
}

interface RecordingJobs {
  readonly jobs: Pick<JobRegistry, "start">;
  readonly started: readonly string[];
}

function createRecordingJobs(): RecordingJobs {
  const started: string[] = [];
  return {
    jobs: {
      start(spec) {
        started.push(spec.kind);
        return JobId(`asr-okf-ingest-${started.length}`);
      },
    },
    started,
  };
}

interface FakeAgentPlan {
  readonly pages?: (request: OkfAgentRequest) => readonly OkfFile[];
  readonly outcome?: OkfAgentOutcome;
}

/**
 * Deterministic stand-in for the child agent. It writes pages the same way the
 * real agent does (agent-owned markdown in the bundle) and records every call.
 */
class FakeAgent implements OkfAgentPort {
  readonly requests: OkfAgentRequest[] = [];

  constructor(private readonly plan: FakeAgentPlan = {}) {}

  async ingest(request: OkfAgentRequest): Promise<OkfAgentOutcome> {
    this.requests.push(request);
    const pages = this.plan.pages?.(request) ?? defaultAgentPages(request);
    for (const page of pages) {
      const target = join(request.directory, ...page.relativePath.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, page.content, "utf8");
    }
    return this.plan.outcome ?? { kind: "ingested" };
  }
}

function defaultAgentPages(request: OkfAgentRequest): readonly OkfFile[] {
  const meeting = request.meeting;
  return [
    {
      relativePath: meetingRelativePath(meeting),
      content: [
        "---",
        "type: Meeting",
        `id: ${meeting.meetingId}`,
        `title: ${meeting.title}`,
        `started: ${new Date(meeting.startedAtMs).toISOString()}`,
        "status: stable",
        `sources: [${meeting.meetingId}]`,
        "---",
        "",
        `# ${meeting.title}`,
        "",
        "Decisions captured by the fake writer.",
        "",
        `- [Transcript](../${request.transcriptCopyPath})`,
        "",
      ].join("\n"),
    },
    {
      relativePath: "actions/send-the-recap.md",
      content: [
        "---",
        "type: Action",
        "id: send-the-recap",
        "title: Send the recap",
        "state: open",
        "owner: Dana",
        "due: 2026-12-01",
        `sources: [${meeting.meetingId}]`,
        `transcript_version: ${meeting.transcriptVersion}`,
        "---",
        "",
        "# Send the recap",
        "",
      ].join("\n"),
    },
    {
      relativePath: "deadlines/recap-delivered.md",
      content: [
        "---",
        "type: Deadline",
        "id: recap-delivered",
        "title: Recap delivered",
        "state: open",
        "due: 2026-12-02",
        `meeting_id: ${meeting.meetingId}`,
        "---",
        "",
        "# Recap delivered",
        "",
      ].join("\n"),
    },
  ];
}

interface HarnessOptions {
  readonly agent?: FakeAgentPlan;
}

interface Harness {
  readonly root: string;
  readonly bundle: string;
  readonly meetings: MeetingRepository;
  readonly database: DatabaseSync;
  readonly attempts: OkfIngestionRepository;
  readonly agent: FakeAgent;
  readonly jobs: RecordingJobs;
  readonly logs: readonly string[];
  readonly service: OkfIngestionService;
  serviceFor(directory: string): OkfIngestionService;
}

function seedMeeting(repository: MeetingRepository): void {
  repository.createImport({
    meetingId: MEETING_ID,
    title: "Weekly planning",
    sourceName: "weekly-planning.wav",
    sourceFormat: "wav",
    sourceSizeBytes: 2_048,
    runId: IMPORT_RUN_ID,
    nowMs: STARTED_AT_MS,
  });
  repository.commitTranscript({
    meetingId: MEETING_ID,
    runId: IMPORT_RUN_ID,
    baseVersion: 0,
    resultStatus: "completed",
    resultReason: null,
    durationMs: 180_000,
    engineFingerprint: "a".repeat(64),
    segments: [
      {
        seq: 0,
        startMs: 0,
        endMs: 5_000,
        speakerLabel: "Speaker A",
        text: "Please read [the doc](https://example.com) before Friday.",
      },
      {
        seq: 1,
        startMs: 5_000,
        endMs: 9_000,
        speakerLabel: "Speaker B",
        text: "Ship the recap.",
      },
    ],
    nowMs: COMMITTED_AT_MS,
  });
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await temporaryRoot();
  const bundle = join(root, "bundle");
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, "README.md"), "# Knowledge bundle\n", "utf8");
  await transaction.initialise(bundle);

  const databasePath = join(root, "meetings.sqlite3");
  const meetings = openMeetingRepository(databasePath);
  seedMeeting(meetings);
  const database = openMeetingDatabase(databasePath);
  closers.push(
    () => {
      database.close();
    },
    () => {
      meetings.close();
    },
  );
  const attempts = createOkfIngestionRepository(database);

  let clock = CLOCK_START_MS;
  const nowMs = (): number => {
    const value = clock;
    clock += 1_000;
    return value;
  };
  const jobs = createRecordingJobs();
  const logs: string[] = [];
  const agent = new FakeAgent(options.agent);

  const serviceFor = (directory: string): OkfIngestionService => {
    const settings: OkfSettings = { directory, ingest: true };
    return createOkfIngestionService({
      repository: meetings,
      attempts,
      git: transaction,
      lock: createOkfBundleLock(),
      agent,
      settings: () => settings,
      jobs: jobs.jobs,
      nowMs,
      logger: (line) => {
        logs.push(line);
      },
    });
  };

  return {
    root,
    bundle,
    meetings,
    database,
    attempts,
    agent,
    jobs,
    logs,
    service: serviceFor(bundle),
    serviceFor,
  };
}

function expectOkfError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(OkfError);
  if (!(error instanceof OkfError)) throw new Error("expected an OkfError");
  expect(error.code).toBe(code);
}

async function failedRun(service: OkfIngestionService): Promise<unknown> {
  return await service.run({ meetingId: MEETING_ID }).then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

describe.skipIf(!gitAvailable())("createOkfIngestionService", () => {
  it("writes the transcript copy, rollups and one commit for a committed meeting", async () => {
    const harness = await createHarness();

    const outcome = await harness.service.run({ meetingId: MEETING_ID });

    expect(outcome.kind).toBe("ingested");
    expect(outcome.meetingId).toBe(MEETING_ID);
    expect(outcome.jobId).toBeNull();
    expect(outcome.message).toMatch(/^Ingested .+@v1 as [0-9a-f]{12}$/u);

    expect(await commitCount(harness.bundle)).toBe(2);
    expect(await lastSubject(harness.bundle)).toBe(`ingest ${MEETING_ID}@v1`);
    expect(await statusPorcelain(harness.bundle)).toBe("");
    await expect(readFile(journalPath(harness.bundle), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const copy = await readFile(
      bundlePath(harness.bundle, transcriptCopyRelativePath(MEETING_ID)),
      "utf8",
    );
    expect(copy).toContain(`meeting_id: ${MEETING_ID}`);
    expect(copy).toContain("transcript_version: 1");
    expect(copy).toContain("status: stable");
    expect(copy).toContain("[00:00:00] **Speaker A:**");
    expect(copy).toContain(
      "Please read \\[the doc\\]\\(https://example\\.com\\) before Friday\\.",
    );

    for (const page of [
      OKF_ROOT_INDEX,
      OKF_MEETINGS_INDEX,
      OKF_ACTIONS_INDEX,
      OKF_DEADLINES_INDEX,
    ]) {
      const content = await readFile(bundlePath(harness.bundle, page), "utf8");
      expect(content.startsWith("---\n")).toBe(true);
    }

    const rootIndex = await readFile(bundlePath(harness.bundle, OKF_ROOT_INDEX), "utf8");
    expect(rootIndex).toContain("[Weekly planning](./meetings/2026-11-20-weekly-planning.md)");
    expect(rootIndex).toContain("[Meetings](./meetings/index.md)");

    const meetingPage = await readFile(bundlePath(harness.bundle, MEETING_PAGE), "utf8");
    expect(meetingPage).toContain("# Weekly planning");

    const meetingsIndex = await readFile(bundlePath(harness.bundle, OKF_MEETINGS_INDEX), "utf8");
    expect(meetingsIndex).toContain("[Weekly planning](./2026-11-20-weekly-planning.md)");

    const actionsIndex = await readFile(bundlePath(harness.bundle, OKF_ACTIONS_INDEX), "utf8");
    expect(actionsIndex).toContain("[Send the recap](./send-the-recap.md)");

    const deadlinesIndex = await readFile(
      bundlePath(harness.bundle, OKF_DEADLINES_INDEX),
      "utf8",
    );
    expect(deadlinesIndex).toContain("**Recap delivered**");
    expect(deadlinesIndex).toContain(`meeting ${MEETING_ID}`);

    const record = harness.service.state(MEETING_ID);
    expect(record).toMatchObject({
      meetingId: MEETING_ID,
      transcriptVersion: 1,
      state: "succeeded",
      attempt: 1,
      directory: await realpath(harness.bundle),
    });
    expect(harness.agent.requests).toHaveLength(1);
  });

  it("increments the attempt and keeps an identical transcript copy untouched", async () => {
    const harness = await createHarness();
    await harness.service.run({ meetingId: MEETING_ID });

    const copyPath = bundlePath(harness.bundle, transcriptCopyRelativePath(MEETING_ID));
    const before = await stat(copyPath, { bigint: true });
    const beforeBytes = await readFile(copyPath, "utf8");

    const outcome = await harness.service.run({ meetingId: MEETING_ID });

    expect(outcome.kind).toBe("ingested");
    expect(await commitCount(harness.bundle)).toBe(3);
    expect(await lastSubject(harness.bundle)).toBe(`ingest ${MEETING_ID}@v1`);
    expect(await statusPorcelain(harness.bundle)).toBe("");

    const after = await stat(copyPath, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(await readFile(copyPath, "utf8")).toBe(beforeBytes);

    const changedBySecondCommit = await git(harness.bundle, [
      "show",
      "--name-only",
      "--format=",
      "HEAD",
    ]);
    expect(changedBySecondCommit).not.toContain("references/transcripts");

    expect(harness.service.state(MEETING_ID)).toMatchObject({
      state: "succeeded",
      attempt: 2,
      transcriptVersion: 1,
    });
    expect(harness.agent.requests).toHaveLength(2);
    expect(harness.agent.requests[1]?.transcriptCopyPath).toBe(
      transcriptCopyRelativePath(MEETING_ID),
    );
  });

  it("rolls the worktree back and records OKF_AGENT_FAILED when the agent fails", async () => {
    const harness = await createHarness({
      agent: { outcome: { kind: "failed", message: "writer unavailable" } },
    });
    const headBefore = await headSha(harness.bundle);
    const countBefore = await commitCount(harness.bundle);
    const treeBefore = await hashTree(harness.bundle);

    const error = await failedRun(harness.service);

    expectOkfError(error, "OKF_AGENT_FAILED");
    expect(error).toMatchObject({ message: "writer unavailable" });
    expect(await headSha(harness.bundle)).toBe(headBefore);
    expect(await commitCount(harness.bundle)).toBe(countBefore);
    expect(await hashTree(harness.bundle)).toBe(treeBefore);
    expect(await statusPorcelain(harness.bundle)).toBe("");
    await expect(
      readFile(bundlePath(harness.bundle, transcriptCopyRelativePath(MEETING_ID)), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(harness.service.state(MEETING_ID)).toMatchObject({
      state: "failed",
      attempt: 1,
      errorCode: "OKF_AGENT_FAILED",
      errorMessage: "writer unavailable",
    });
  });

  it("rejects a page linking outside the bundle without committing anything", async () => {
    const harness = await createHarness({
      agent: {
        pages: (request) => [
          ...defaultAgentPages(request),
          {
            relativePath: "actions/leak.md",
            content: [
              "---",
              "type: Action",
              "id: leak",
              "title: Leak",
              "state: open",
              `sources: [${request.meeting.meetingId}]`,
              "---",
              "",
              "[elsewhere](../../outside.md)",
              "",
            ].join("\n"),
          },
        ],
      },
    });
    const headBefore = await headSha(harness.bundle);
    const countBefore = await commitCount(harness.bundle);
    const treeBefore = await hashTree(harness.bundle);

    const error = await failedRun(harness.service);

    expectOkfError(error, "OKF_LINK_OUTSIDE_BUNDLE");
    expect(error).toMatchObject({ message: /link\(s\) leave the Open knowledge base/u });
    expect(await headSha(harness.bundle)).toBe(headBefore);
    expect(await commitCount(harness.bundle)).toBe(countBefore);
    expect(await hashTree(harness.bundle)).toBe(treeBefore);
    expect(await statusPorcelain(harness.bundle)).toBe("");
    await expect(readFile(bundlePath(harness.bundle, "actions/leak.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    expect(harness.service.state(MEETING_ID)).toMatchObject({
      state: "failed",
      errorCode: "OKF_LINK_OUTSIDE_BUNDLE",
    });
  });

  it("fails with OKF_NOT_VERSIONED before recording an attempt in a plain folder", async () => {
    const harness = await createHarness();
    const plain = join(harness.root, "plain");
    await mkdir(plain);
    await writeFile(join(plain, "note.md"), "# Not a repository\n", "utf8");
    const treeBefore = await hashTree(plain);

    const error = await failedRun(harness.serviceFor(plain));

    expectOkfError(error, "OKF_NOT_VERSIONED");
    expect(harness.attempts.listForMeeting(MEETING_ID, 10)).toHaveLength(0);
    expect(await hashTree(plain)).toBe(treeBefore);
    await expect(readdir(join(plain, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not start work when no folder is configured", async () => {
    const harness = await createHarness();
    const entriesBefore = (await readdir(harness.bundle)).sort();

    const outcome = harness.serviceFor("").start({ meetingId: MEETING_ID });

    expect(outcome).toMatchObject({
      kind: "disabled",
      meetingId: MEETING_ID,
      jobId: null,
    });
    expect(harness.jobs.started).toHaveLength(0);
    expect(harness.attempts.listForMeeting(MEETING_ID, 10)).toHaveLength(0);
    expect((await readdir(harness.bundle)).sort()).toEqual(entriesBefore);
    expect(await statusPorcelain(harness.bundle)).toBe("");
  });

  it("recovers a stale journal on startup without throwing", async () => {
    const harness = await createHarness();
    const headBefore = await headSha(harness.bundle);

    await transaction.begin({
      root: harness.bundle,
      label: "recover-test@v1",
      nowMs: STARTED_AT_MS,
    });
    await mkdir(join(harness.bundle, "meetings"), { recursive: true });
    await writeFile(join(harness.bundle, "meetings", "crashed.md"), "# crashed\n", "utf8");

    await expect(readFile(journalPath(harness.bundle), "utf8")).resolves.toContain(
      "recover-test@v1",
    );

    await expect(harness.service.recoverStartup()).resolves.toBeUndefined();

    await expect(readFile(journalPath(harness.bundle), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await headSha(harness.bundle)).toBe(headBefore);
    expect(await statusPorcelain(harness.bundle)).toBe("");
    await expect(
      readFile(join(harness.bundle, "meetings", "crashed.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.logs.join("\n")).toContain(
      "recovered interrupted OKF ingestion recover-test@v1",
    );
  });
});
