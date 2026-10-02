import { expect, it } from "vitest";

import { stableVadPrefix } from "../../src/recording/stable-vad-prefix.js";

it("requires twenty seconds of age while always retaining the last two chunks", () => {
  const chunks = [
    { startMs: 0, endMs: 5_000 },
    { startMs: 6_000, endMs: 10_000 },
    { startMs: 11_000, endMs: 15_000 },
    { startMs: 16_000, endMs: 20_000 },
    { startMs: 21_000, endMs: 25_000 },
  ];

  expect(stableVadPrefix(chunks, 45_000)).toEqual(chunks.slice(0, 3));
  expect(stableVadPrefix(chunks, 35_000)).toEqual(chunks.slice(0, 3));
  expect(stableVadPrefix(chunks.slice(0, 2), 120_000)).toEqual([]);
});
