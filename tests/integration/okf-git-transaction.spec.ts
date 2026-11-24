import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OkfError } from "../../src/okf/contracts.js";
import { createOkfBundleLock } from "../../src/okf/bundle-lock.js";
import {
  OKF_INGESTION_JOURNAL_FILE,
  createOkfGitTransaction,
  type OkfGitBeginOptions,
  type OkfGitSession,
} from "../../src/okf/git-transaction.js";
import {
  createInjectingGitPort,
  createRealGitPort,
  createRecordingGitPort,
  createTemporaryRoot,
  gitAvailable,
  gitText,
  hashTree,
  writeFiles,
} from "../helpers/okf-git.js";

const LABEL = "ingest-11111111-1111-4111-8111-111111111111@v1";
const NOW_MS = Date.parse("2026-11-24T11:00:00.000Z");

const GIT_ARGV_PREFIX: readonly string[] = [
  "--no-pager",
  "-c", "user.name=dsh-asr",
  "-c", "user.email=dsh-asr@localhost",
  "-c", "commit.gpgsign=false",
  "-c", "core.hooksPath=",
];

const realPort = createRealGitPort();
const transaction = createOkfGitTransaction(realPort);
const roots: string[] = [];

async function temporaryRoot(prefix?: string): Promise<string> {
  const root = await createTemporaryRoot(prefix);
  roots.push(root);
  return root;
}

function journalPath(root: string): string {
  return join(root, ".git", OKF_INGESTION_JOURNAL_FILE);
}

function beginOptions(root: string, label = LABEL): OkfGitBeginOptions {
  return { root, label, nowMs: NOW_MS };
}

async function headSubject(root: string): Promise<string> {
  return (await gitText(realPort, ["log", "-1", "--format=%s"], root)).trim();
}

async function headSha(root: string): Promise<string> {
  return (await gitText(realPort, ["rev-parse", "HEAD"], root)).trim();
}

async function trackedNames(root: string): Promise<readonly string[]> {
  const output = await gitText(realPort, ["ls-tree", "-r", "--name-only", "HEAD"], root);
  return output.split("\n").filter((line) => line !== "");
}

async function writeJournalFile(
  root: string,
  record: Readonly<Record<string, unknown>>,
): Promise<void> {
  await writeFile(journalPath(root), `${JSON.stringify(record)}\n`, "utf8");
}

async function createCommittedBundle(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await temporaryRoot();
  await writeFiles(root, files);
  await transaction.initialise(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!gitAvailable())("okf git transaction", () => {
  describe("inspect", () => {
    it("reports a plain folder as unversioned, not nested and not clean", async () => {
      const root = await temporaryRoot();
      await writeFiles(root, { "index.md": "# bundle\n" });

      expect(await transaction.inspect(root)).toEqual({
        versioned: false,
        nested: false,
        clean: false,
      });
    });

    it("reports a work tree top level as versioned and clean until a file changes", async () => {
      const root = await createCommittedBundle({ "index.md": "# bundle\n" });

      expect(await transaction.inspect(root)).toEqual({
        versioned: true,
        nested: false,
        clean: true,
      });

      await writeFile(join(root, "index.md"), "# changed\n");
      expect((await transaction.inspect(root)).clean).toBe(false);
    });

    it("reports a folder inside another repository as nested and unversioned", async () => {
      const parent = await createCommittedBundle({ "index.md": "# parent\n" });
      const child = join(parent, "bundle");
      await mkdir(child);

      const inspection = await transaction.inspect(child);
      expect(inspection.versioned).toBe(false);
      expect(inspection.nested).toBe(true);
    });

    it("reports a nested repository that is its own top level as versioned and nested", async () => {
      const parent = await createCommittedBundle({ "index.md": "# parent\n" });
      const root = join(parent, "bundle");
      await mkdir(root);
      await writeFiles(root, { "index.md": "# inner bundle\n" });
      await transaction.initialise(root);

      expect(await transaction.inspect(root)).toEqual({
        versioned: true,
        nested: true,
        clean: true,
      });
    });
  });

  describe("initialise", () => {
    it("initialises an empty folder without creating a commit", async () => {
      const root = await temporaryRoot();
      await transaction.initialise(root);

      expect(await readdir(root)).toEqual([".git"]);
      expect((await transaction.inspect(root)).versioned).toBe(true);
      expect((await gitText(realPort, ["ls-files"], root)).trim()).toBe("");

      const head = await realPort.run(["git", "rev-parse", "--verify", "--quiet", "HEAD"], {
        cwd: root,
      });
      expect(head.code).not.toBe(0);
    });

    it("commits a non-empty folder exactly once and is idempotent", async () => {
      const root = await temporaryRoot();
      await writeFiles(root, { "index.md": "# bundle\n", "meetings/m1.md": "# m1\n" });
      await transaction.initialise(root);
      await transaction.initialise(root);

      expect(await headSubject(root)).toBe("initial okf bundle");
      expect((await gitText(realPort, ["rev-list", "--count", "HEAD"], root)).trim()).toBe("1");
      expect(await gitText(realPort, ["show", "HEAD:meetings/m1.md"], root)).toBe("# m1\n");
    });
  });

  describe("begin", () => {
    it("refuses to begin outside a git work tree", async () => {
      const root = await temporaryRoot();
      await writeFiles(root, { "index.md": "# bundle\n" });

      await expect(transaction.begin(beginOptions(root))).rejects.toMatchObject({
        name: "OkfError",
        code: "OKF_NOT_VERSIONED",
      });
    });

    it("rejects labels with characters outside [a-z0-9@._ -]", async () => {
      const root = await createCommittedBundle({ "index.md": "# bundle\n" });

      for (const label of ["Ingest@v1", "ingest/1111@v1", "ingest\n1111@v1", ""]) {
        await expect(transaction.begin({ root, label, nowMs: NOW_MS })).rejects.toMatchObject({
          name: "OkfError",
          code: "OKF_GIT_FAILED",
        });
      }
      await expect(readFile(journalPath(root), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("commit", () => {
    it("records exactly one new commit labelled with the ingestion label", async () => {
      const root = await createCommittedBundle({ "index.md": "# bundle\n" });
      const baseline = await headSha(root);

      const session = await transaction.begin(beginOptions(root));
      await writeFiles(root, { "meetings/m1.md": "# meeting\n", "index.md": "# updated\n" });
      const result = await session.commit();

      expect(result.commit).toMatch(/^[0-9a-f]{40}$/u);
      expect((await gitText(realPort, ["rev-list", "--count", "HEAD"], root)).trim()).toBe("2");
      expect(await headSubject(root)).toBe(LABEL);
      expect((await gitText(realPort, ["rev-parse", "HEAD^"], root)).trim()).toBe(baseline);
      expect(await gitText(realPort, ["show", "HEAD:meetings/m1.md"], root)).toBe("# meeting\n");
      expect((await gitText(realPort, ["status", "--porcelain"], root)).trim()).toBe("");
      await expect(readFile(journalPath(root), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("writes the journal before the worktree changes", async () => {
      const root = await createCommittedBundle({ "index.md": "# bundle\n" });
      const baseline = await headSha(root);

      await transaction.begin(beginOptions(root));

      const journal = JSON.parse(await readFile(journalPath(root), "utf8")) as Record<
        string,
        unknown
      >;
      expect(journal["label"]).toBe(LABEL);
      expect(journal["baselineKind"]).toBe("commit");
      expect(journal["baselineSha"]).toBe(baseline);
      expect(journal["startedAtMs"]).toBe(NOW_MS);
      expect(journal["pid"]).toBe(process.pid);
    });
  });

  describe("rollback", () => {
    it("restores the worktree byte-identically after a failed attempt", async () => {
      const root = await createCommittedBundle({
        "index.md": "# bundle\n",
        "meetings/a.md": "# a\n",
        "meetings/nested/b.md": "# b\n",
      });
      const baseline = await headSha(root);
      const before = await hashTree(root);

      const session = await transaction.begin(beginOptions(root));
      try {
        await writeFiles(root, {
          "meetings/a.md": "# a changed\n",
          "meetings/new.md": "# new\n",
          "scratch/tmp.md": "temporary\n",
        });
        await rm(join(root, "meetings/nested/b.md"));
        throw new Error("simulated mid-flight failure");
      } catch {
        // The caller rolls back when the attempt fails.
      }
      await session.rollback();

      expect(await hashTree(root)).toBe(before);
      expect(await headSha(root)).toBe(baseline);
      expect((await gitText(realPort, ["status", "--porcelain"], root)).trim()).toBe("");
      await expect(readFile(journalPath(root), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("creates one snapshot commit for pre-existing edits and restores them on rollback", async () => {
      const root = await createCommittedBundle({
        "index.md": "# base\n",
        "tracked.md": "v1\n",
        ".gitignore": "ignored.log\n",
      });
      await writeFile(join(root, "tracked.md"), "v2\n");
      await writeFile(join(root, "untracked.md"), "new\n");
      await writeFile(join(root, "ignored.log"), "keep me\n");
      const dirtyHash = await hashTree(root);

      const session = await transaction.begin(beginOptions(root));

      expect(await headSubject(root)).toBe("pre-ingest snapshot 2026-11-24T11:00:00.000Z");
      expect(await gitText(realPort, ["show", "HEAD:tracked.md"], root)).toBe("v2\n");
      expect(await gitText(realPort, ["show", "HEAD:untracked.md"], root)).toBe("new\n");
      expect(await trackedNames(root)).not.toContain("ignored.log");

      const journal = JSON.parse(await readFile(journalPath(root), "utf8")) as Record<
        string,
        unknown
      >;
      expect(journal["baselineSha"]).toBe(await headSha(root));

      await writeFiles(root, { "attempt.md": "partial\n", "tracked.md": "v3\n" });
      await rm(join(root, "untracked.md"));
      await session.rollback();

      expect(await hashTree(root)).toBe(dirtyHash);
      expect(await readFile(join(root, "tracked.md"), "utf8")).toBe("v2\n");
      expect(await readFile(join(root, "untracked.md"), "utf8")).toBe("new\n");
      expect(await readFile(join(root, "ignored.log"), "utf8")).toBe("keep me\n");
      await expect(readFile(join(root, "attempt.md"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("leaves an ignored file untouched while removing fresh untracked files", async () => {
      const root = await createCommittedBundle({
        "index.md": "# bundle\n",
        ".gitignore": "*.log\n",
      });
      const ignored = join(root, "session.log");
      await writeFile(ignored, "user owned\n");

      const session = await transaction.begin(beginOptions(root));
      await writeFiles(root, { "fresh.md": "temporary\n", "session.log": "rewritten\n" });
      await session.rollback();

      expect(await readFile(ignored, "utf8")).toBe("rewritten\n");
      await expect(readFile(join(root, "fresh.md"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("rolls back an abort before the attempt leaves a partial worktree", async () => {
      const root = await createCommittedBundle({ "index.md": "# bundle\n" });
      const before = await hashTree(root);
      const controller = new AbortController();

      const session = await transaction.begin({
        ...beginOptions(root),
        signal: controller.signal,
      });
      await writeFiles(root, { "pending.md": "partial\n" });
      controller.abort();

      await expect(session.commit()).rejects.toThrow();
      expect(await hashTree(root)).toBe(before);
      await expect(readFile(journalPath(root), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("empty repository baseline", () => {
    it("rolls back to an unborn HEAD with an empty index", async () => {
      const root = await temporaryRoot();
      await transaction.initialise(root);
      const before = await hashTree(root);

      const session = await transaction.begin(beginOptions(root));
      const journal = JSON.parse(await readFile(journalPath(root), "utf8")) as Record<
        string,
        unknown
      >;
      expect(journal["baselineKind"]).toBe("empty-tree");
      expect(journal["baselineSha"]).toBeNull();

      await writeFiles(root, { "index.md": "# new\n", "meetings/m1.md": "# m1\n" });
      await session.rollback();

      expect(await hashTree(root)).toBe(before);
      const head = await realPort.run(["git", "rev-parse", "--verify", "--quiet", "HEAD"], {
        cwd: root,
      });
      expect(head.code).not.toBe(0);
      expect((await gitText(realPort, ["status", "--porcelain"], root)).trim()).toBe("");
      await expect(readFile(journalPath(root), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("drops a crashed attempt's first commit when the baseline was the empty tree", async () => {
      const root = await temporaryRoot();
      await transaction.initialise(root);
      const before = await hashTree(root);

      const session = await transaction.begin(beginOptions(root));
      await writeFiles(root, { "index.md": "# attempt\n" });
      await session.commit();
      // Simulate a crash between the commit and the journal removal.
      await writeJournalFile(root, {
        version: 1,
        label: "ingest-crash@v1",
        baselineKind: "empty-tree",
        baselineSha: null,
        startedAtMs: NOW_MS,
        pid: 4242,
      });

      expect(await transaction.recoverInterrupted(root)).toEqual({ label: "ingest-crash@v1" });

      expect(await hashTree(root)).toBe(before);
      const head = await realPort.run(["git", "rev-parse", "--verify", "--quiet", "HEAD"], {
        cwd: root,
      });
      expect(head.code).not.toBe(0);
      expect((await gitText(realPort, ["status", "--porcelain"], root)).trim()).toBe("");
    });
  });

  describe("journal recovery", () => {
    it("returns undefined without a journal", async () => {
      const root = await createCommittedBundle({ "index.md": "# bundle\n" });
      expect(await transaction.recoverInterrupted(root)).toBeUndefined();
    });

    it("rolls back to the recorded baseline and returns the label", async () => {
      const root = await createCommittedBundle({ "index.md": "# bundle\n" });
      const baseline = await headSha(root);
      const before = await hashTree(root);
      await writeJournalFile(root, {
        version: 1,
        label: "ingest-recovery@v2",
        baselineKind: "commit",
        baselineSha: baseline,
        startedAtMs: NOW_MS,
        pid: 4242,
      });
      await writeFiles(root, { "half-written.md": "partial\n", "index.md": "# broken\n" });

      expect(await transaction.recoverInterrupted(root)).toEqual({ label: "ingest-recovery@v2" });

      expect(await hashTree(root)).toBe(before);
      expect(await headSha(root)).toBe(baseline);
      await expect(readFile(journalPath(root), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("recovers a stale journal before beginning a new attempt", async () => {
      const root = await createCommittedBundle({ "index.md": "# bundle\n" });
      const baseline = await headSha(root);
      await writeJournalFile(root, {
        version: 1,
        label: "ingest-stale@v1",
        baselineKind: "commit",
        baselineSha: baseline,
        startedAtMs: NOW_MS - 60_000,
        pid: 4242,
      });
      await writeFiles(root, { "stale.md": "left over\n" });

      const session = await transaction.begin(beginOptions(root));

      await expect(readFile(join(root, "stale.md"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await writeFiles(root, { "meetings/m1.md": "# m1\n" });
      await session.commit();
      expect(await headSubject(root)).toBe(LABEL);
    });

    it("keeps an unreadable journal and reports OKF_JOURNAL_UNCLOSED", async () => {
      const root = await createCommittedBundle({ "index.md": "# bundle\n" });
      await writeFile(journalPath(root), "{not json", "utf8");

      await expect(transaction.recoverInterrupted(root)).rejects.toMatchObject({
        name: "OkfError",
        code: "OKF_JOURNAL_UNCLOSED",
      });
      expect(await readFile(journalPath(root), "utf8")).toBe("{not json");
    });
  });

  describe("git invocations", () => {
    it("uses argv arrays with the fixed prefix, absolute cwd and no clean -x", async () => {
      const recording = createRecordingGitPort(createRealGitPort());
      const recordingTransaction = createOkfGitTransaction(recording);
      const root = await temporaryRoot();
      await writeFiles(root, { "index.md": "# bundle\n" });

      await recordingTransaction.initialise(root);
      const session = await recordingTransaction.begin(beginOptions(root));
      await writeFiles(root, { "meetings/m1.md": "# m1\n" });
      await session.commit();

      expect(recording.invocations.length).toBeGreaterThan(0);
      for (const invocation of recording.invocations) {
        expect(invocation.argv[0]).toBe("git");
        expect(invocation.argv.slice(1, 1 + GIT_ARGV_PREFIX.length)).toEqual([
          ...GIT_ARGV_PREFIX,
        ]);
        expect(invocation.argv.length).toBeGreaterThan(1 + GIT_ARGV_PREFIX.length);
        expect(invocation.argv).not.toContain("-x");
        expect(isAbsolute(invocation.cwd)).toBe(true);
      }
      const commands = recording.invocations.map((invocation) =>
        invocation.argv.slice(1 + GIT_ARGV_PREFIX.length),
      );
      expect(commands).toContainEqual(["commit", "--no-verify", "-m", LABEL]);
    });
  });

  describe("foreign git index lock", () => {
    it("returns OKF_BUSY after bounded retries and never removes the lock", async () => {
      const root = await createCommittedBundle({ "index.md": "# bundle\n" });
      const inner = createRealGitPort();
      let addAttempts = 0;
      const lockingPort = createInjectingGitPort(inner, (argv) => {
        if (!argv.includes("add")) return undefined;
        addAttempts += 1;
        return {
          code: 128,
          stdout: "",
          stderr: "fatal: Unable to create '.git/index.lock': File exists.\n",
        };
      });
      const lockingTransaction = createOkfGitTransaction(lockingPort);
      const session = await lockingTransaction.begin(beginOptions(root));

      vi.useFakeTimers({ toFake: ["setTimeout"] });
      let error: unknown;
      try {
        const attempt = session.commit().then(
          () => undefined,
          (cause: unknown) => cause,
        );
        await vi.runAllTimersAsync();
        error = await attempt;
      } finally {
        vi.useRealTimers();
      }

      expect(error).toBeInstanceOf(OkfError);
      expect((error as OkfError).code).toBe("OKF_BUSY");
      expect(addAttempts).toBe(8);
      await session.rollback();
    });
  });
});

describe("okf bundle lock", () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolveGate: () => void = () => undefined;
    const promise = new Promise<void>((resolvePromise) => {
      resolveGate = resolvePromise;
    });
    return { promise, resolve: resolveGate };
  }

  it("serialises two tasks on the same bundle root in arrival order", async () => {
    const root = await temporaryRoot();
    const lock = createOkfBundleLock();
    const gate = deferred();
    const events: string[] = [];

    const first = lock.runExclusive(root, async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
      return 1;
    });
    const second = lock.runExclusive(root, async () => {
      events.push("second:start");
      events.push("second:end");
      return 2;
    });

    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 0));
    expect(events).toEqual(["first:start"]);

    gate.resolve();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("serialises a symlink alias of the same bundle root", async () => {
    const realRoot = await temporaryRoot();
    const aliasParent = await temporaryRoot();
    const alias = join(aliasParent, "bundle-link");
    await symlink(realRoot, alias);
    const lock = createOkfBundleLock();
    const gate = deferred();
    const events: string[] = [];

    const first = lock.runExclusive(realRoot, async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    });
    const second = lock.runExclusive(alias, async () => {
      events.push("second:start");
    });

    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 0));
    expect(events).toEqual(["first:start"]);

    gate.resolve();
    await first;
    await second;
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("runs tasks on different bundle roots concurrently", async () => {
    const rootA = await temporaryRoot();
    const rootB = await temporaryRoot();
    const lock = createOkfBundleLock();
    const gate = deferred();
    let started = 0;
    let signalBothStarted: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolveBoth) => {
      signalBothStarted = () => {
        started += 1;
        if (started === 2) resolveBoth();
      };
    });
    const task = async (): Promise<string> => {
      signalBothStarted();
      await gate.promise;
      return "done";
    };

    const first = lock.runExclusive(rootA, task);
    const second = lock.runExclusive(rootB, task);

    try {
      await Promise.race([
        bothStarted,
        new Promise<never>((_resolve, rejectTimeout) => {
          setTimeout(() => rejectTimeout(new Error("tasks on different roots did not overlap")), 2_000);
        }),
      ]);
    } finally {
      gate.resolve();
    }

    await expect(Promise.all([first, second])).resolves.toEqual(["done", "done"]);
  });
});

describe.skipIf(!gitAvailable())("okf git transaction session lifecycle", () => {
  it("refuses to roll back a committed transaction", async () => {
    const root = await createCommittedBundle({ "index.md": "# bundle\n" });
    const session: OkfGitSession = await transaction.begin(beginOptions(root));
    await writeFiles(root, { "meetings/m1.md": "# m1\n" });
    await session.commit();

    await expect(session.rollback()).rejects.toMatchObject({
      name: "OkfError",
      code: "OKF_GIT_FAILED",
    });
  });
});
