import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  openManagedPcm16Wav,
  prepareManagedAudioRoot,
} from "../../src/worker/managed-audio.js";
import { createWave } from "../helpers/wav-fixture.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ allowed: string; audio: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), "dsh-worker-audio-"));
  temporaryDirectories.push(root);
  const allowed = join(root, "meeting");
  const outside = join(root, "outside.wav");
  const audio = join(allowed, "audio.wav");
  await mkdir(allowed);
  await writeFile(audio, createWave(new Int16Array(16_000)));
  await writeFile(outside, createWave(new Int16Array(16_000)));
  return { allowed, audio, outside };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })));
});

describe("managed Worker audio", () => {
  it("opens a canonical WAV inside the one allowed meeting directory", async () => {
    const { allowed, audio } = await fixture();
    const root = await prepareManagedAudioRoot(allowed);
    const reader = await openManagedPcm16Wav(root, audio, 1_000);

    expect(reader.metadata.durationMs).toBe(1_000);
    await reader.close();
  });

  it("rejects a symlink whose real target escapes the meeting directory", async () => {
    const { allowed, outside } = await fixture();
    const link = join(allowed, "linked.wav");
    await symlink(outside, link);
    const root = await prepareManagedAudioRoot(allowed);

    await expect(openManagedPcm16Wav(root, link, 1_000)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("rejects a duration that differs from the verified WAV header", async () => {
    const { allowed, audio } = await fixture();
    const root = await prepareManagedAudioRoot(allowed);

    await expect(openManagedPcm16Wav(root, audio, 1_002)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});
