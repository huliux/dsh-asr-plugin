import { dirname } from "node:path";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";
import type { RecordingHelperSubprocess } from "./helper-client.js";

const MAX_INVENTORY_BYTES = 64 * 1_024;
const MAX_DEVICES = 64;
const MAX_TEXT = 256;
const TIMEOUT_MS = 15_000;

export interface AudioDevice {
  /** CoreAudio UID; stable across launches and the value the capture child pins. */
  readonly uid: string;
  readonly name: string;
  readonly inputChannels: number;
  readonly outputChannels: number;
  readonly defaultInput: boolean;
  readonly defaultOutput: boolean;
}

export interface AudioDeviceInventory {
  readonly defaultInputUID: string | null;
  readonly defaultOutputUID: string | null;
  readonly devices: readonly AudioDevice[];
}

export interface AudioDeviceService {
  list(signal?: AbortSignal): Promise<AudioDeviceInventory>;
}

export class AudioDeviceError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super("Audio device inventory is unavailable", options);
    this.name = "AudioDeviceError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AudioDeviceError("DEVICES_UNAVAILABLE");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT) {
    throw new AudioDeviceError("DEVICES_UNAVAILABLE");
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 512) {
    throw new AudioDeviceError("DEVICES_UNAVAILABLE");
  }
  return value as number;
}

function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new AudioDeviceError("DEVICES_UNAVAILABLE");
  return value;
}

function device(value: unknown): AudioDevice {
  const item = record(value);
  return {
    uid: text(item.uid),
    name: text(item.name),
    inputChannels: count(item.input_channels),
    outputChannels: count(item.output_channels),
    defaultInput: flag(item.default_input),
    defaultOutput: flag(item.default_output),
  };
}

/** Parses the helper's `__devices` payload; unknown shapes are rejected wholesale. */
export function parseAudioDeviceInventory(value: unknown): AudioDeviceInventory {
  const payload = record(value);
  if (payload.schema_version !== 1) throw new AudioDeviceError("DEVICES_UNAVAILABLE");
  const devices = payload.devices;
  if (!Array.isArray(devices) || devices.length > MAX_DEVICES) {
    throw new AudioDeviceError("DEVICES_UNAVAILABLE");
  }
  return {
    defaultInputUID: optionalText(payload.default_input_uid),
    defaultOutputUID: optionalText(payload.default_output_uid),
    devices: devices.map(device),
  };
}

export interface AudioDeviceServiceOptions {
  /** Resolves the signed helper bundle root. */
  readonly resolveApp: () => Promise<string>;
  readonly subprocess: RecordingHelperSubprocess;
  readonly timeoutMs?: number;
}

/**
 * Enumerates CoreAudio devices through the recording helper. The helper owns
 * the CoreAudio binding, so the Host never needs its own audio dependency.
 */
export function createAudioDeviceService(options: AudioDeviceServiceOptions): AudioDeviceService {
  let pending: Promise<AudioDeviceInventory> | undefined;
  return {
    list(signal) {
      if (signal?.aborted === true) return Promise.reject(new AudioDeviceError("CANCELLED_BY_USER"));
      // Two panels asking at once must not spawn two helpers.
      pending ??= read(options).finally(() => { pending = undefined; });
      return signal === undefined ? pending : pending.then((value) => {
        if (signal.aborted) throw new AudioDeviceError("CANCELLED_BY_USER");
        return value;
      });
    },
  };
}

async function read(options: AudioDeviceServiceOptions): Promise<AudioDeviceInventory> {
  const app = await options.resolveApp();
  const binary = `${app}/Contents/MacOS/DSHASRRecordingHelper`;
  const bounded = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS);
  const handle: SubprocessHandle = options.subprocess.spawn({
    argv: [binary, "__devices"],
    cwd: dirname(app),
    stdio: { stdin: "ignore", stdout: { maxBytes: MAX_INVENTORY_BYTES }, stderr: { maxBytes: 4_096 } },
    graceMs: 500,
  });
  try {
    if (!await handle.waitForExit(bounded)) throw new AudioDeviceError("DEVICES_UNAVAILABLE");
    const outcome = await handle.done;
    if (outcome.exitCode !== 0 || outcome.signal !== null) throw new AudioDeviceError("DEVICES_UNAVAILABLE");
    const raw = handle.collected.stdout?.readFrom(0).text ?? "";
    if (raw.length === 0 || raw.length > MAX_INVENTORY_BYTES) throw new AudioDeviceError("DEVICES_UNAVAILABLE");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (error) { throw new AudioDeviceError("DEVICES_UNAVAILABLE", { cause: error }); }
    return parseAudioDeviceInventory(parsed);
  } finally {
    await handle.waitForExit(AbortSignal.timeout(1_000)).catch(() => false);
    handle.terminate();
  }
}
