import { chmod, lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  isSqliteBusy,
  openSqliteExclusiveLease,
} from "../storage/sqlite-exclusive-lease.js";
import { RuntimeAssetsError } from "./runtime-assets-error.js";

const LEASE_RETRY_MS = 50;
const LEASE_WAIT_LIMIT_MS = 15 * 60 * 1_000;

function fileSystemErrorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function aborted(): never {
  throw new RuntimeAssetsError("STAGE_ABORTED", "Model pack staging was cancelled");
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) aborted();
}

async function assertLeasePath(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new RuntimeAssetsError("MODEL_NOT_READY", "Model staging lease path is invalid");
    }
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return;
    throw error;
  }
}

async function tryAcquire(path: string): Promise<AsyncDisposable | undefined> {
  try {
    await assertLeasePath(path);
    return await openSqliteExclusiveLease(path);
  } catch (error) {
    if (isSqliteBusy(error)) return undefined;
    if (error instanceof RuntimeAssetsError) throw error;
    throw new RuntimeAssetsError("MODEL_NOT_READY", "Model staging lease could not be acquired");
  }
}

async function waitToRetry(signal: AbortSignal | undefined, deadline: number): Promise<void> {
  if (Date.now() >= deadline) {
    throw new RuntimeAssetsError("MODEL_NOT_READY", "Model staging lease timed out");
  }
  try {
    await delay(LEASE_RETRY_MS, undefined, signal === undefined ? {} : { signal });
  } catch (error) {
    if (signal?.aborted === true) aborted();
    throw error;
  }
}

export async function acquireModelStageLease(
  dataRoot: string,
  signal?: AbortSignal,
): Promise<AsyncDisposable> {
  assertNotAborted(signal);
  const root = resolve(dataRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const leasePath = join(root, "asset-stage-lease.sqlite3");
  const deadline = Date.now() + LEASE_WAIT_LIMIT_MS;
  while (true) {
    assertNotAborted(signal);
    const lease = await tryAcquire(leasePath);
    if (lease !== undefined) return lease;
    await waitToRetry(signal, deadline);
  }
}
