import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { acquireDataRootLease } from "../../src/storage/data-root-lease.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-lease-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("同一数据根只允许一个生命周期持有者并在正常释放后可重获", async () => {
  const root = await temporaryRoot();
  const first = await acquireDataRootLease(root);
  let reacquired: AsyncDisposable | undefined;
  try {
    await expect(acquireDataRootLease(root)).rejects.toMatchObject({
      name: "MeetingRepositoryError",
      code: "DATA_ROOT_IN_USE",
      message: "Meeting data root is already in use",
    });
    await first[Symbol.asyncDispose]();
    await first[Symbol.asyncDispose]();
    reacquired = await acquireDataRootLease(root);
  } finally {
    await reacquired?.[Symbol.asyncDispose]();
    await first[Symbol.asyncDispose]();
  }

  expect((await stat(root)).mode & 0o777).toBe(0o700);
  expect((await stat(join(root, "host-lease.sqlite3"))).mode & 0o777).toBe(0o600);
});

it("非锁竞争的 SQLite 失败保持为存储故障", async () => {
  const root = await temporaryRoot();
  await mkdir(join(root, "host-lease.sqlite3"));

  await expect(acquireDataRootLease(root)).rejects.toMatchObject({
    name: "MeetingRepositoryError",
    code: "STORAGE_FAILURE",
    message: "Meeting data root lease could not be acquired",
  });
});

it("拒绝非绝对数据根且不触碰文件系统", async () => {
  await expect(acquireDataRootLease("relative-data-root")).rejects.toMatchObject({
    name: "MeetingRepositoryError",
    code: "INVALID_INPUT",
    message: "Meeting data root must be absolute",
  });
});
