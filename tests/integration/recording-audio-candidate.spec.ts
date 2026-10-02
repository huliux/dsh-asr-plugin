import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  buildRecordingAudioCandidate,
  verifyAndPromoteRecordingAudio,
} from "../../src/audio/recording-audio-candidate.js";
import { openClosedRecordingChunks } from "../../src/audio/closed-recording-chunks.js";
import { createWave } from "../helpers/wav-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

it("leaves a bounded candidate in work until the Host verifies and promotes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "recording-candidate-"));
  roots.push(root);
  const meetingDirectory = join(root, "meetings", "meeting");
  const recordingDirectory = join(meetingDirectory, "recording");
  const workRecordingDirectory = join(root, "work", "meeting", "recording");
  const mic = join(recordingDirectory, "mic", "chunks");
  const system = join(recordingDirectory, "system", "chunks");
  await Promise.all([mkdir(mic, { recursive: true }), mkdir(system, { recursive: true })]);
  await writeFile(join(mic, "1000000-1001000.wav"), createWave(new Int16Array(16).fill(1_000)));
  await writeFile(join(system, "1000500-1001500.wav"), createWave(new Int16Array(16).fill(3_000)));
  const paths = { meetingDirectory, recordingDirectory, workRecordingDirectory };

  const candidate = await buildRecordingAudioCandidate(
    paths,
    await openClosedRecordingChunks(recordingDirectory),
  );

  await expect(stat(join(meetingDirectory, "audio.wav"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(candidate.audioFiles).toEqual(["audio.tmp.wav", "mic.tmp.wav", "system.tmp.wav"]);
  const audio = await readFile(join(workRecordingDirectory, "audio.tmp.wav"));
  expect(candidate.sourceSha256).toBe(createHash("sha256").update(audio).digest("hex"));

  const promoted = await verifyAndPromoteRecordingAudio(paths, candidate);
  expect(promoted.sourcePath).toBe(join(meetingDirectory, "audio.wav"));
  await expect(stat(join(recordingDirectory, "mic.wav"))).resolves.toBeDefined();
  await expect(stat(join(recordingDirectory, "system.wav"))).resolves.toBeDefined();
  await expect(stat(join(recordingDirectory, "mic", "chunks")))
    .rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(recordingDirectory, "system", "chunks")))
    .rejects.toMatchObject({ code: "ENOENT" });
});
