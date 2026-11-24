import type { Context } from "@deepseek-ai/cordis";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";

import { OkfError, type OkfGitPort, type OkfGitResult } from "./contracts.js";

/** Upper bound on one git invocation; a hung git must not hold the bundle lock forever. */
const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/** Enough for `git log --stat` and the largest plausible status output, no more. */
const MAX_STREAM_BYTES = 4 * 1024 * 1024;

export interface OkfGitPortOptions {
  readonly timeoutMs?: number;
  /** Executable name; overridable so tests can point at a stub. */
  readonly executable?: string;
}

/**
 * Runs git through the subprocess seam with an argv array and no shell, so no
 * value from a transcript, a commit label or a bundle path can be re-parsed as
 * shell syntax. The child environment is the harness-scrubbed parent env.
 *
 * `argv[0]` is the program, matching the subprocess seam; `executable` replaces
 * it so a test can point the port at a stub without changing the call sites.
 */
export function createOkfGitPort(context: Context, options: OkfGitPortOptions = {}): OkfGitPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  return {
    async run(argv, spec): Promise<OkfGitResult> {
      if (argv.length === 0) {
        throw new OkfError("OKF_GIT_FAILED", "git was invoked without a program name");
      }
      const program = options.executable ?? argv[0] ?? "";
      const forwarded: readonly string[] = [program, ...argv.slice(1)];
      const bounded = spec.signal === undefined
        ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([spec.signal, AbortSignal.timeout(timeoutMs)]);
      let handle: SubprocessHandle;
      try {
        handle = context.subprocess.spawn({
          argv: forwarded,
          cwd: spec.cwd,
          stdio: {
            stdin: "ignore",
            stdout: { maxBytes: MAX_STREAM_BYTES },
            stderr: { maxBytes: MAX_STREAM_BYTES },
          },
          graceMs: 500,
        });
      } catch (error) {
        throw new OkfError("OKF_GIT_FAILED", "git could not be started", { cause: error });
      }
      try {
        if (!await handle.waitForExit(bounded)) {
          throw new OkfError("OKF_GIT_FAILED", "git did not finish in time");
        }
        const outcome = await handle.done;
        return {
          code: outcome.exitCode,
          stdout: handle.collected.stdout?.readFrom(0).text ?? "",
          stderr: handle.collected.stderr?.readFrom(0).text ?? "",
        };
      } catch (error) {
        if (error instanceof OkfError) throw error;
        throw new OkfError("OKF_GIT_FAILED", "git did not run to completion", { cause: error });
      } finally {
        await handle.waitForExit(AbortSignal.timeout(1_000)).catch(() => false);
        handle.terminate();
      }
    },
  };
}
