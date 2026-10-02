import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { openPcm16Wav } from "../audio/wav-reader.js";
import type { Pcm16WavReader } from "../audio/wav-reader.js";
import { WorkerRuntimeError } from "./worker-errors.js";

const DURATION_TOLERANCE_MS = 1;

export async function prepareManagedAudioRoot(directory: string): Promise<string> {
  if (!isAbsolute(directory)) {
    throw new WorkerRuntimeError("INVALID_REQUEST", "Managed audio root must be absolute");
  }
  try {
    const canonical = await realpath(directory);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch (error) {
    if (error instanceof WorkerRuntimeError) throw error;
    throw new WorkerRuntimeError("INVALID_REQUEST", "Managed audio root is invalid", undefined, {
      cause: error,
    });
  }
}

function assertInsideRoot(root: string, filePath: string): void {
  const pathFromRoot = relative(root, filePath);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) throw new WorkerRuntimeError("INVALID_REQUEST", "Audio path escapes the managed root");
}

async function canonicalAudioPath(root: string, audioPath: string): Promise<string> {
  if (!isAbsolute(audioPath)) {
    throw new WorkerRuntimeError("INVALID_REQUEST", "Audio path must be absolute");
  }
  let canonical: string;
  try {
    canonical = await realpath(audioPath);
  } catch (error) {
    throw new WorkerRuntimeError("AUDIO_READ_FAILED", "Managed audio is unavailable", undefined, {
      cause: error,
    });
  }
  assertInsideRoot(root, canonical);
  return canonical;
}

export async function openManagedPcm16Wav(
  managedRoot: string,
  audioPath: string,
  durationMs: number,
): Promise<Pcm16WavReader> {
  const reader = await openPcm16Wav(await canonicalAudioPath(managedRoot, audioPath));
  if (Math.abs(reader.metadata.durationMs - durationMs) <= DURATION_TOLERANCE_MS) return reader;
  await reader.close().catch(() => undefined);
  throw new WorkerRuntimeError("INVALID_REQUEST", "Audio duration does not match its header");
}
