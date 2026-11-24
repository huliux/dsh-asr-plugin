/**
 * In-process serialisation for one OKF bundle directory.
 *
 * Two ingestions of the same bundle must never interleave: the git transaction
 * records a baseline and a journal in the shared `.git` directory, so a second
 * begin would roll back the first attempt's worktree. The lock is keyed by the
 * real path of the bundle root (symlink aliases share one queue) and is a FIFO
 * chain of promises, so waiting tasks run in arrival order. Different bundles
 * keep separate chains and run concurrently.
 *
 * The lock lives in one process only; it is not an inter-process mutex. The git
 * journal plus the `index.lock` retry path cover concurrent host processes.
 */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export interface OkfBundleLock {
  runExclusive<T>(root: string, task: () => Promise<T>): Promise<T>;
}

async function lockKey(root: string): Promise<string> {
  const absolute = resolve(root);
  try {
    return await realpath(absolute);
  } catch {
    // The bundle may not exist yet (initialise runs before the first ingestion);
    // the resolved absolute path is still a stable key then.
    return absolute;
  }
}

export function createOkfBundleLock(): OkfBundleLock {
  const tails = new Map<string, Promise<void>>();

  return {
    async runExclusive<T>(root: string, task: () => Promise<T>): Promise<T> {
      const key = await lockKey(root);
      const previous = tails.get(key) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolveHeld) => {
        release = resolveHeld;
      });
      // `previous` never rejects: every tail resolves when its holder releases.
      const tail = previous.then(() => held);
      tails.set(key, tail);
      try {
        await previous;
        return await task();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  };
}
