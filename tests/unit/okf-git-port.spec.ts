import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";

import { OkfError } from "../../src/okf/contracts.js";
import { createOkfGitPort, type OkfGitPortOptions } from "../../src/okf/git-port.js";

interface ReadRecord {
  readonly stream: "stdout" | "stderr";
  readonly fromByte: number;
}

interface HarnessOptions {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly done?: Promise<SubprocessOutcome>;
  readonly waitForExit?: (signal?: AbortSignal) => Promise<boolean>;
  readonly spawnError?: Error;
  readonly port?: OkfGitPortOptions;
}

function reader(text: string, stream: "stdout" | "stderr", reads: ReadRecord[]): SubprocessOutputReader {
  return {
    readFrom(fromByte: number): SubprocessOutputRead {
      reads.push({ stream, fromByte });
      return { text, nextOffset: fromByte + text.length, lossy: false };
    },
  };
}

function harness(options: HarnessOptions = {}) {
  const specs: SubprocessSpawnSpec[] = [];
  const reads: ReadRecord[] = [];
  const terminate = vi.fn();
  const waitForExit = vi.fn(options.waitForExit ?? (async () => true));
  const done = options.done
    ?? Promise.resolve<SubprocessOutcome>({
      exitCode: options.exitCode === undefined ? 0 : options.exitCode,
      signal: null,
    });
  const handle: SubprocessHandle = {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: reader(options.stdout ?? "", "stdout", reads),
      stderr: reader(options.stderr ?? "", "stderr", reads),
    },
    done,
    terminate,
    waitForExit,
  };
  const spawn = vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => {
    specs.push(spec);
    if (options.spawnError !== undefined) throw options.spawnError;
    return handle;
  });
  const context = { subprocess: { spawn } } as unknown as Context;
  return {
    port: createOkfGitPort(context, options.port ?? {}),
    specs,
    reads,
    spawn,
    terminate,
    waitForExit,
  };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the git port to reject");
}

const WORK_TREE = "/work/tree";

describe("createOkfGitPort", () => {
  it("spawns git directly with the argv array and the requested cwd", async () => {
    const test = harness({ stdout: " M docs/okf.md\n" });
    const result = await test.port.run(
      ["git", "-C", "/repo", "status", "--porcelain"],
      { cwd: WORK_TREE },
    );

    expect(result).toEqual({ code: 0, stdout: " M docs/okf.md\n", stderr: "" });
    expect(test.specs).toHaveLength(1);
    expect(test.specs[0]?.argv).toEqual(["git", "-C", "/repo", "status", "--porcelain"]);
    expect(test.specs[0]?.cwd).toBe(WORK_TREE);
    expect(test.specs[0]?.stdio.stdin).toBe("ignore");
    expect(typeof test.specs[0]?.stdio.stdout).toBe("object");
    expect(typeof test.specs[0]?.stdio.stderr).toBe("object");
    // The seam takes every argument in argv and receives no shell or env override.
    expect(Object.keys(test.specs[0] ?? {}).sort()).toEqual(["argv", "cwd", "graceMs", "stdio"]);
    expect(test.terminate).toHaveBeenCalledTimes(1);
  });

  it("reads stdout and stderr from offset zero after the exit", async () => {
    const test = harness({ stdout: "out\n", stderr: "err\n" });
    const result = await test.port.run(["git", "status"], { cwd: WORK_TREE });

    expect(result).toEqual({ code: 0, stdout: "out\n", stderr: "err\n" });
    expect(test.reads).toEqual([
      { stream: "stdout", fromByte: 0 },
      { stream: "stderr", fromByte: 0 },
    ]);
  });

  it("uses the configured executable as argv[0]", async () => {
    const test = harness({ port: { executable: "/opt/homebrew/bin/git" } });
    await test.port.run(["git", "rev-parse", "HEAD"], { cwd: WORK_TREE });
    expect(test.specs[0]?.argv).toEqual(["/opt/homebrew/bin/git", "rev-parse", "HEAD"]);
  });

  it("forwards a null exit code for a signalled process", async () => {
    const test = harness({ exitCode: null });
    const result = await test.port.run(["git", "fetch"], { cwd: WORK_TREE });
    expect(result.code).toBeNull();
    expect(test.terminate).toHaveBeenCalledTimes(1);
  });

  it("fails with OKF_GIT_FAILED and terminates when git times out", async () => {
    const test = harness({ waitForExit: async () => false });
    const error = await rejected(test.port.run(["git", "status"], { cwd: WORK_TREE }));

    expect(error).toBeInstanceOf(OkfError);
    expect(error).toMatchObject({ code: "OKF_GIT_FAILED" });
    expect(test.terminate).toHaveBeenCalledTimes(1);
    expect(test.waitForExit).toHaveBeenCalledTimes(2);
    expect(test.waitForExit.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(test.waitForExit.mock.calls[1]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it("wraps a provider failure after spawn as OKF_GIT_FAILED", async () => {
    const done = Promise.reject(new Error("provider lost the child"));
    void done.catch(() => undefined);
    const test = harness({ done });
    const error = await rejected(test.port.run(["git", "status"], { cwd: WORK_TREE }));

    expect(error).toBeInstanceOf(OkfError);
    expect(error).toMatchObject({
      code: "OKF_GIT_FAILED",
      cause: expect.objectContaining({ message: "provider lost the child" }),
    });
    expect(test.terminate).toHaveBeenCalledTimes(1);
  });

  // Known gap: git-port.ts calls context.subprocess.spawn outside its try block,
  // so a synchronous spawn failure escapes unwrapped. it.fails pins the intended
  // contract without leaving the suite red; flip it to `it` once spawn is wrapped.
  it("wraps a synchronous spawn failure as OKF_GIT_FAILED", async () => {
    const test = harness({ spawnError: new Error("ENOENT: git not found") });
    const error = await rejected(test.port.run(["git", "status"], { cwd: WORK_TREE }));

    expect(error).toBeInstanceOf(OkfError);
    expect(error).toMatchObject({ code: "OKF_GIT_FAILED" });
  });
});
