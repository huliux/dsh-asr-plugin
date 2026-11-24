/**
 * Shared harness for the OKF git transaction suite: a real `git` port, ports
 * that record or inject invocations, temporary bundle roots and a recursive
 * content hash used to prove rollback is byte-identical.
 */

import { spawn, spawnSync } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import type { OkfGitPort, OkfGitResult } from "../../src/okf/contracts.js";

export interface GitInvocation {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly signalAborted: boolean;
}

export interface RecordingGitPort extends OkfGitPort {
  readonly invocations: readonly GitInvocation[];
}

export function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** The production-shaped port: argv arrays, no shell, inherited environment. */
export function createRealGitPort(): OkfGitPort {
  return {
    run(argv, options): Promise<OkfGitResult> {
      return new Promise<OkfGitResult>((resolveRun, rejectRun) => {
        const [command, ...args] = argv;
        if (command === undefined) {
          rejectRun(new Error("empty git argv"));
          return;
        }
        const spawnOptions: SpawnOptions = {
          cwd: options.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        };
        const child = spawn(command, args, spawnOptions);
        let stdout = "";
        let stderr = "";
        let settled = false;
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", (error: Error) => {
          if (settled) return;
          settled = true;
          if (error.name === "AbortError") {
            rejectRun(error);
            return;
          }
          resolveRun({ code: null, stdout, stderr: `${stderr}${error.message}` });
        });
        child.on("close", (code: number | null) => {
          if (settled) return;
          settled = true;
          resolveRun({ code, stdout, stderr });
        });
      });
    },
  };
}

export function createRecordingGitPort(inner: OkfGitPort): RecordingGitPort {
  const invocations: GitInvocation[] = [];
  return {
    get invocations(): readonly GitInvocation[] {
      return invocations;
    },
    async run(argv, options) {
      invocations.push({
        argv: [...argv],
        cwd: options.cwd,
        signalAborted: options.signal?.aborted === true,
      });
      return inner.run(argv, options);
    },
  };
}

/**
 * Delegates to the real port unless the hook returns a synthetic result, which
 * lets a test fail one command (for example every `add`) deterministically.
 */
export function createInjectingGitPort(
  inner: OkfGitPort,
  inject: (argv: readonly string[]) => OkfGitResult | undefined,
): OkfGitPort {
  return {
    async run(argv, options) {
      const injected = inject(argv);
      if (injected !== undefined) return injected;
      return inner.run(argv, options);
    },
  };
}

export async function createTemporaryRoot(prefix = "dsh-asr-okf-git-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

export async function writeFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
}

/**
 * Recursive content hash of a worktree, excluding `.git`. Paths, entry kinds and
 * file bytes (or symlink targets) all participate, so any leftover, lost or
 * rewritten byte changes the hash.
 */
export async function hashTree(root: string): Promise<string> {
  const entries: string[] = [];
  const hash = createHash("sha256");

  async function walk(directory: string): Promise<void> {
    const dirents = await readdir(directory, { withFileTypes: true });
    dirents.sort((left, right) => left.name.localeCompare(right.name));
    for (const dirent of dirents) {
      if (dirent.name === ".git") continue;
      const absolute = join(directory, dirent.name);
      const relativePath = relative(root, absolute).split(sep).join("/");
      if (dirent.isSymbolicLink()) {
        entries.push(`link ${relativePath} ${await readlink(absolute)}`);
      } else if (dirent.isDirectory()) {
        entries.push(`dir ${relativePath}`);
        await walk(absolute);
      } else if (dirent.isFile()) {
        const bytes = createHash("sha256").update(await readFile(absolute)).digest("hex");
        entries.push(`file ${relativePath} ${bytes}`);
      }
    }
  }

  await walk(root);
  return hash.update(entries.join("\n")).digest("hex");
}

export async function gitText(
  port: OkfGitPort,
  argv: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await port.run(["git", ...argv], { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${argv.join(" ")} failed with code ${String(result.code)}: ${result.stderr}`);
  }
  return result.stdout;
}
