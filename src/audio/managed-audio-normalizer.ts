import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  open,
  rename,
  rm,
} from "node:fs/promises";

import type { SubprocessHandle, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";

import { AudioReadError } from "./errors.js";
import { ManagedAudioError } from "./managed-audio-error.js";
import type { AudioSourceFormat } from "./source-format.js";
import { openPcm16Wav } from "./wav-reader.js";
import type { Pcm16WavMetadata } from "./wav-reader.js";

const CONVERSION_TIMEOUT_MS = 10 * 60 * 1_000;
const PROCESS_TREE_WAIT_MS = 15_000;
const CONVERSION_GRACE_MS = 2_000;

export interface AudioConversionSubprocess {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
}

export interface NormalizedAudio {
  readonly audioPath: string;
  readonly durationMs: number;
  readonly frameCount: number;
}

export interface NormalizeManagedAudioInput {
  readonly audioPath: string;
  readonly audioTemporaryPath: string;
  readonly conversionDeadline?: (() => AbortSignal) | undefined;
  readonly meetingDirectory: string;
  readonly signal?: AbortSignal | undefined;
  readonly sourceFormat: AudioSourceFormat;
  readonly sourcePath: string;
  readonly subprocess: AudioConversionSubprocess;
  readonly workDirectory: string;
}

function engineFailure(message: string, cause?: unknown): ManagedAudioError {
  return new ManagedAudioError(
    "ENGINE_FAILURE",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function storageFailure(message: string, cause: unknown): ManagedAudioError {
  return new ManagedAudioError("STORAGE_FAILURE", message, { cause });
}

function cancelled(): ManagedAudioError {
  return new ManagedAudioError("CANCELLED_BY_USER", "Audio normalization was cancelled");
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function mapSourceReadError(error: AudioReadError): ManagedAudioError | null {
  if (error.reason === "UNSUPPORTED_FORMAT") return null;
  if (error.reason === "AUDIO_TOO_LONG") {
    return new ManagedAudioError("AUDIO_TOO_LONG", "Audio exceeds four hours", { cause: error });
  }
  if (error.reason === "IO_FAILURE") {
    return storageFailure("Managed audio source could not be read", error);
  }
  return new ManagedAudioError("AUDIO_DECODE_FAILED", "WAV input is damaged", { cause: error });
}

async function inspectCanonicalWav(sourcePath: string): Promise<Pcm16WavMetadata | null> {
  try {
    const reader = await openPcm16Wav(sourcePath);
    try {
      return reader.metadata;
    } finally {
      await reader.close();
    }
  } catch (error) {
    if (!(error instanceof AudioReadError)) throw storageFailure("WAV input could not be inspected", error);
    const mapped = mapSourceReadError(error);
    if (mapped !== null) throw mapped;
    return null;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, constants.O_RDWR);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertRegularOutput(filePath: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    throw engineFailure("Audio converter did not produce an output", error);
  }
  if (!stats.isFile() || stats.size === 0) {
    throw engineFailure("Audio converter produced an invalid output");
  }
}

async function verifyConvertedWav(filePath: string): Promise<Pcm16WavMetadata> {
  await assertRegularOutput(filePath);
  try {
    const reader = await openPcm16Wav(filePath);
    try {
      return reader.metadata;
    } finally {
      await reader.close();
    }
  } catch (error) {
    if (error instanceof AudioReadError && error.reason === "AUDIO_TOO_LONG") {
      throw new ManagedAudioError("AUDIO_TOO_LONG", "Audio exceeds four hours", { cause: error });
    }
    throw engineFailure("Audio converter produced an invalid WAV", error);
  }
}

function conversionSpec(input: NormalizeManagedAudioInput, signal: AbortSignal): SubprocessSpawnSpec {
  return {
    argv: [
      "/usr/bin/afconvert",
      input.sourcePath,
      "-f", "WAVE",
      "-d", "LEI16@16000",
      "-c", "1",
      "--mix",
      input.audioTemporaryPath,
    ],
    cwd: input.workDirectory,
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: 1_024 },
      stderr: { maxBytes: 8_192 },
    },
    graceMs: CONVERSION_GRACE_MS,
    signal,
    env: { LANG: "C", LC_ALL: "C" },
  };
}

async function waitForTree(handle: SubprocessHandle): Promise<void> {
  const exited = await handle.waitForExit(AbortSignal.timeout(PROCESS_TREE_WAIT_MS));
  if (exited) return;
  handle.terminate();
  throw engineFailure("Audio converter process tree did not exit");
}

async function runConverter(input: NormalizeManagedAudioInput): Promise<void> {
  if (isAborted(input.signal)) throw cancelled();
  const deadline = (input.conversionDeadline ??
    (() => AbortSignal.timeout(CONVERSION_TIMEOUT_MS)))();
  const signal = input.signal === undefined
    ? deadline
    : AbortSignal.any([input.signal, deadline]);
  let handle: SubprocessHandle;
  try {
    handle = input.subprocess.spawn(conversionSpec(input, signal));
  } catch (error) {
    throw engineFailure("Audio converter could not be started", error);
  }
  let outcome;
  try {
    outcome = await handle.done;
  } catch (error) {
    if (isAborted(input.signal)) throw cancelled();
    if (deadline.aborted) throw engineFailure("Audio conversion timed out", error);
    throw engineFailure("Audio converter could not be started", error);
  }
  await waitForTree(handle);
  if (isAborted(input.signal)) throw cancelled();
  if (deadline.aborted) throw engineFailure("Audio conversion timed out");
  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    throw new ManagedAudioError("AUDIO_DECODE_FAILED", "Audio decoder rejected the input");
  }
}

async function finalizeOutput(input: NormalizeManagedAudioInput): Promise<Pcm16WavMetadata> {
  const metadata = await verifyConvertedWav(input.audioTemporaryPath);
  try {
    await chmod(input.audioTemporaryPath, 0o600);
    await syncFile(input.audioTemporaryPath);
    await rename(input.audioTemporaryPath, input.audioPath);
    await syncDirectory(input.meetingDirectory);
    await syncDirectory(input.workDirectory);
    return metadata;
  } catch (error) {
    throw storageFailure("Normalized audio could not be committed", error);
  }
}

export async function normalizeManagedAudio(
  input: NormalizeManagedAudioInput,
): Promise<NormalizedAudio> {
  if (isAborted(input.signal)) throw cancelled();
  await rm(input.audioTemporaryPath, { force: true }).catch((error: unknown) => {
    throw storageFailure("Stale audio work could not be removed", error);
  });
  try {
    const canonical = input.sourceFormat === "wav"
      ? await inspectCanonicalWav(input.sourcePath)
      : null;
    if (canonical === null) {
      await runConverter(input);
    } else {
      await copyFile(input.sourcePath, input.audioTemporaryPath, constants.COPYFILE_EXCL);
    }
    if (isAborted(input.signal)) throw cancelled();
    const metadata = await finalizeOutput(input);
    return {
      audioPath: input.audioPath,
      durationMs: metadata.durationMs,
      frameCount: metadata.frameCount,
    };
  } catch (error) {
    await rm(input.audioTemporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof ManagedAudioError) throw error;
    throw storageFailure("Audio could not be normalized", error);
  }
}
