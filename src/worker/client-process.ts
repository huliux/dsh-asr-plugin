import { isAbsolute } from "node:path";
import { finished } from "node:stream/promises";
import type { Readable, Writable } from "node:stream";

import type {
  WorkerLaunchSpec,
  WorkerProcessHandle,
  WorkerProcessOutcome,
} from "./process.js";
import type { StderrTail } from "./stderr-tail.js";

export interface WorkerSessionStreams {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

export interface WorkerFailureSettlement {
  readonly outcome?: WorkerProcessOutcome;
  readonly quiet: boolean;
}

export const EMPTY_STDERR: StderrTail = { text: "", truncated: false };

export class WorkerWaitFailure<P extends string = string> extends Error {
  constructor(
    readonly reason: "cancelled" | "timeout",
    readonly phase: P,
  ) {
    super(`Worker wait ${reason}`);
  }
}

export class WorkerProcessFailure extends Error {}

export function assertPositiveTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new TypeError("Worker timeouts must be positive safe timer values");
  }
}

export function assertWorkerLaunch(spec: WorkerLaunchSpec): void {
  if (
    spec.argv.length === 0 ||
    spec.argv.some((item) => item.length === 0) ||
    !isAbsolute(spec.cwd)
  ) throw new TypeError("Worker launch spec is invalid");
  assertPositiveTimeout(spec.graceMs);
}

export function requireWorkerStreams(handle: WorkerProcessHandle): WorkerSessionStreams {
  if (handle.stdin === undefined || handle.stdout === undefined || handle.stderr === undefined) {
    throw new WorkerProcessFailure("Worker protocol requires three pipes");
  }
  return { stdin: handle.stdin, stdout: handle.stdout, stderr: handle.stderr };
}

export async function waitBounded<T, P extends string>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  deadline: number,
  phase: P,
): Promise<T> {
  if (signal?.aborted === true) throw new WorkerWaitFailure("cancelled", phase);
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new WorkerWaitFailure("timeout", phase);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = (): void => finish(() => reject(new WorkerWaitFailure("cancelled", phase)));
    const timer = setTimeout(
      () => finish(() => reject(new WorkerWaitFailure("timeout", phase))),
      remaining,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export async function waitAbortable<T, P extends string>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  phase: P,
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) throw new WorkerWaitFailure("cancelled", phase);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = (): void => finish(() => reject(new WorkerWaitFailure("cancelled", phase)));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export async function closeWorkerInput(stream: Writable): Promise<void> {
  stream.end();
  await finished(stream, { cleanup: true, readable: false });
}

export function destroyWorkerStreams(handle: WorkerProcessHandle): void {
  handle.stdin?.destroy();
  handle.stdout?.destroy();
  handle.stderr?.destroy();
}

async function settlePromise<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  const deadline = performance.now() + timeoutMs;
  try {
    return await waitBounded(promise, undefined, deadline, "termination");
  } catch {
    return undefined;
  }
}

export async function settleWorkerFailure(
  handle: WorkerProcessHandle,
  timeoutMs: number,
): Promise<WorkerFailureSettlement> {
  try {
    handle.terminate();
  } catch {
    destroyWorkerStreams(handle);
    return { quiet: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let quiet = false;
  try {
    quiet = await handle.waitForExit(controller.signal);
  } catch {
    quiet = false;
  } finally {
    clearTimeout(timer);
  }
  const outcome = await settlePromise(handle.done, timeoutMs);
  destroyWorkerStreams(handle);
  return { quiet, ...(outcome === undefined ? {} : { outcome }) };
}

export async function requireWorkerTreeExit<P extends string>(
  handle: WorkerProcessHandle,
  signal: AbortSignal | undefined,
  deadline: number,
  phase: P,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const exited = await waitBounded(handle.waitForExit(controller.signal), signal, deadline, phase);
    if (!exited) throw new WorkerProcessFailure("Worker process tree remained live");
  } finally {
    clearTimeout(timer);
  }
}
