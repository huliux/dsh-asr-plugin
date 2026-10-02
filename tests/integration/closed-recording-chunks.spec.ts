import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { openClosedRecordingChunks } from "../../src/audio/closed-recording-chunks.js";
import { renderRecordingWindow } from "../../src/audio/recording-timeline.js";
import { createWave } from "../helpers/wav-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

it("scans only closed mic/system WAVs and reads a bounded mixed window", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-closed-chunks-"));
  roots.push(root);
  const recording = join(root, "recording");
  const mic = join(recording, "mic", "chunks");
  const system = join(recording, "system", "chunks");
  await mkdir(mic, { recursive: true, mode: 0o700 });
  await mkdir(system, { recursive: true, mode: 0o700 });
  await writeFile(join(mic, "1000000-1001000.wav"), createWave(new Int16Array(16).fill(32_767)));
  await writeFile(join(system, "1000500-1001500.wav"), createWave(new Int16Array(16).fill(-32_768)));
  await writeFile(join(mic, ".unfinished.tmp"), Buffer.from("not closed"));

  const chunks = await openClosedRecordingChunks(recording);
  const timeline = await chunks.scan();
  expect(timeline).toMatchObject({ originUs: 1_000_000, frameCount: 24 });
  const mixed = await renderRecordingWindow(
    timeline!,
    0,
    24,
    (chunk, start, end) => chunks.read(chunk, start, end),
  );
  expect([...mixed]).toEqual([
    ...new Array(8).fill(1),
    ...new Array(8).fill(0),
    ...new Array(8).fill(-1),
  ]);
});

it("fails explicitly when a previously closed chunk disappears", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-missing-chunk-"));
  roots.push(root);
  const recording = join(root, "recording");
  const mic = join(recording, "mic", "chunks");
  const system = join(recording, "system", "chunks");
  await mkdir(mic, { recursive: true, mode: 0o700 });
  await mkdir(system, { recursive: true, mode: 0o700 });
  const path = join(mic, "1000000-1001000.wav");
  await writeFile(path, createWave(new Int16Array(16).fill(1_000)));
  const chunks = await openClosedRecordingChunks(recording);
  await expect(chunks.scan()).resolves.toBeDefined();

  await rm(path);

  await expect(chunks.scan()).rejects.toMatchObject({ code: "AUDIO_READ_FAILED" });
});
