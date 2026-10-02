import { describe, expect, it } from "vitest";

import {
  WORKER_READY_TIMEOUT_MS,
  WORKER_TERMINATION_GRACE_MS,
  WORKER_TERMINATION_TIMEOUT_MS,
  workerRunDeadlineMs,
} from "../../src/worker/timeouts.js";

describe("Worker timeout policy", () => {
  it("冻结 READY 与进程树收敛 timeout", () => {
    expect(WORKER_READY_TIMEOUT_MS).toBe(30_000);
    expect(WORKER_TERMINATION_GRACE_MS).toBe(2_000);
    expect(WORKER_TERMINATION_TIMEOUT_MS).toBe(15_000);
  });

  it.each([
    [1, 180_000],
    [30 * 60_000, 180_000],
    [30 * 60_000 + 1, 240_000],
    [11_019_301, 540_000],
    [4 * 60 * 60_000, 600_000],
  ])("把 %i ms 音频映射到 %i ms deadline", (durationMs, expected) => {
    expect(workerRunDeadlineMs(durationMs)).toBe(expected);
  });

  it.each([0, 1.5, Number.NaN, 4 * 60 * 60_000 + 1])(
    "拒绝越界时长 %s",
    (durationMs) => {
      expect(() => workerRunDeadlineMs(durationMs)).toThrow("Worker duration is invalid");
    },
  );
});
