import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type {
  WorkerLaunchSpec,
  WorkerProcessHandle,
  WorkerProcessOutcome,
  WorkerSpawner,
} from "./process.js";

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if its process group has already gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Idempotent termination treats an already-gone child as success.
  }
}

function waitForSettlement(
  done: Promise<WorkerProcessOutcome>,
  isSettled: () => boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (isSettled()) return Promise.resolve(true);
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (value: boolean): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    done.then(() => finish(true), () => finish(true));
  });
}

function spawnNodeWorker(spec: WorkerLaunchSpec): WorkerProcessHandle {
  const [command, ...args] = spec.argv;
  if (command === undefined) throw new TypeError("Worker argv must contain an executable");
  const child = spawn(command, args, {
    cwd: spec.cwd,
    detached: process.platform !== "win32",
    env: { ...spec.environment },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let settled = false;
  let escalation: NodeJS.Timeout | undefined;
  const done = new Promise<WorkerProcessOutcome>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      settled = true;
      if (escalation !== undefined) clearTimeout(escalation);
      resolve({ exitCode, signal });
    });
  });
  return {
    stdin: child.stdin ?? undefined,
    stdout: child.stdout ?? undefined,
    stderr: child.stderr ?? undefined,
    done,
    terminate() {
      if (settled || escalation !== undefined) return;
      signalTree(child, "SIGTERM");
      escalation = setTimeout(() => signalTree(child, "SIGKILL"), spec.graceMs);
    },
    waitForExit(signal) {
      return waitForSettlement(done, () => settled, signal);
    },
  };
}

export function createNodeWorkerSpawner(): WorkerSpawner {
  return { spawn: spawnNodeWorker };
}
