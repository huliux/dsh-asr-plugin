import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";

import type { RecordingAudioLayout } from "../storage/managed-audio-store.js";
import {
  readRecordingHelperEvent,
  readRecordingHelperControlFlag,
  RecordingHelperProtocolError,
  type RecordingHelperEvent,
} from "./helper-events.js";
import type {
  RecordingHelperSession,
  RecordingHelperSnapshot,
  RecordingHelperTrackSnapshot,
  RecordingSessionHelperFactory,
  RecordingTrack,
} from "./recording-session.js";

const POLL_MS = 25;
const DIAGNOSTIC_BYTES = 4 * 1_024;

export interface RecordingHelperSubprocess {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
}

export interface RecordingHelperClientOptions {
  readonly appRoot: string;
  readonly commandTimeoutMs: number;
  readonly hostProcessId: number;
  readonly readyTimeoutMs: number;
  readonly subprocess: RecordingHelperSubprocess;
  readonly terminationTimeoutMs: number;
}

export class RecordingHelperClientError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super("Recording helper failed", options);
    this.name = "RecordingHelperClientError";
  }
}

function assertOptions(options: RecordingHelperClientOptions): void {
  if (!isAbsolute(options.appRoot)) throw new TypeError("Recording helper app path must be absolute");
  if (!Number.isSafeInteger(options.hostProcessId) ||
    options.hostProcessId < 2 || options.hostProcessId > 2_147_483_647) {
    throw new TypeError("Recording helper Host process id must be valid");
  }
  for (const timeout of [
    options.commandTimeoutMs,
    options.readyTimeoutMs,
    options.terminationTimeoutMs,
  ]) {
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new TypeError("Recording helper timeout must be positive");
    }
  }
}

function clientError(error: unknown, fallback = "HELPER_PROCESS_ERROR"): RecordingHelperClientError {
  if (error instanceof RecordingHelperClientError) return error;
  if (error instanceof RecordingHelperProtocolError) {
    return new RecordingHelperClientError(error.code, { cause: error });
  }
  if (typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string") {
    return new RecordingHelperClientError(error.code, { cause: error });
  }
  return new RecordingHelperClientError(fallback, { cause: error });
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new RecordingHelperClientError("CANCELLED_BY_USER"));
      return;
    }
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => done(new RecordingHelperClientError("CANCELLED_BY_USER"));
    function done(error?: Error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fsyncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeCommand(path: string, value: Record<string, unknown>): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await fsyncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new RecordingHelperClientError("HELPER_IO_FAILED", { cause: error });
  }
}

function initialTrack(): RecordingHelperTrackSnapshot {
  return { requested: true, state: "starting", errorCode: null };
}

function failedTrack(
  track: RecordingHelperTrackSnapshot,
  code: string,
): RecordingHelperTrackSnapshot {
  if (!track.requested || track.state === "failed") return track;
  return { requested: true, state: "failed", errorCode: code };
}

class ActiveRecordingHelperSession implements RecordingHelperSession {
  readonly completion: Promise<void>;
  private acknowledgedCommandId = 0;
  private captureEndUs = 0;
  private commandId = 0;
  private commandTail = Promise.resolve();
  private failed: RecordingHelperClientError | null = null;
  private helperReady = false;
  private mic = initialTrack();
  private nextEvent = 1;
  private outcome: SubprocessOutcome | null = null;
  private readonly pumpAbort = new AbortController();
  private readonly pumpTask: Promise<void>;
  private stopped = false;
  private system = initialTrack();

  constructor(
    private readonly options: RecordingHelperClientOptions,
    private readonly handle: SubprocessHandle,
    private readonly sessionRoot: string,
    private readonly meetingId: string,
  ) {
    this.pumpTask = this.pump();
    this.completion = Promise.all([this.pumpTask, this.observeProcess()]).then(() => undefined);
    void this.completion.catch(() => undefined);
  }

  snapshot(): RecordingHelperSnapshot {
    return { mic: this.mic, system: this.system, captureEndUs: this.captureEndUs };
  }

  waitUntilReady(signal: AbortSignal): Promise<RecordingHelperSession> {
    return this.waitFor(
      () => this.helperReady && (this.mic.state === "on" || this.system.state === "on"),
      this.options.readyTimeoutMs,
      "HELPER_READY_TIMEOUT",
      signal,
    ).then(() => this);
  }

  setTrack(track: RecordingTrack, requested: boolean): Promise<RecordingHelperSnapshot> {
    return this.enqueue(async () => {
      const current = this.snapshot()[track];
      const target = requested
        ? current.requested && (current.state === "on" || current.state === "starting")
        : !current.requested && current.state === "off";
      if (target) return this.snapshot();
      await this.issue(`${track}_${requested ? "on" : "off"}`);
      await this.waitFor(
        () => requested
          ? ["on", "failed"].includes(this.snapshot()[track].state)
          : this.snapshot()[track].state === "off",
        this.options.commandTimeoutMs,
        "HELPER_COMMAND_TIMEOUT",
      );
      return this.snapshot();
    });
  }

  stop(): Promise<RecordingHelperSnapshot> {
    return this.enqueue(async () => {
      if (!this.stopped) await this.issue("stop");
      await this.waitFor(
        () => this.stopped,
        this.options.commandTimeoutMs,
        "HELPER_COMMAND_TIMEOUT",
      );
      await this.waitForCleanExit();
      return this.snapshot();
    });
  }

  terminate(): Promise<void> {
    return this.enqueue(async () => {
      try {
        if (this.outcome === null && !this.stopped) {
          await this.issue("stop");
          await this.waitFor(
            () => this.stopped,
            this.options.commandTimeoutMs,
            "HELPER_COMMAND_TIMEOUT",
          );
        }
        if (!this.stopped) throw new RecordingHelperClientError("HELPER_PROCESS_ERROR");
        await this.waitForTree();
      } catch {
        await this.forceTerminate();
      } finally {
        this.pumpAbort.abort();
        await this.pumpTask.catch(() => undefined);
      }
    });
  }

  async forceTerminate(): Promise<void> {
    try {
      await writeCommand(join(this.sessionRoot, "control", "host-cancel.json"), {
        schema_version: 1, cancel: true,
      });
      await this.waitForCancellation();
      await this.waitForTree();
    } finally {
      this.pumpAbort.abort();
      await this.pumpTask.catch(() => undefined);
    }
  }

  private async waitForCancellation(): Promise<void> {
    const control = join(this.sessionRoot, "control");
    const deadline = performance.now() + this.options.terminationTimeoutMs;
    let protocolFailure: RecordingHelperClientError | undefined;
    while (true) {
      try {
        if (await this.cancellationIsComplete(control)) return;
      } catch (error) {
        protocolFailure = clientError(error);
      }
      if (performance.now() >= deadline) {
        throw protocolFailure ?? new RecordingHelperClientError("HELPER_TERMINATION_TIMEOUT");
      }
      await delay(POLL_MS);
    }
  }

  private async cancellationIsComplete(control: string): Promise<boolean> {
    if (await readRecordingHelperControlFlag(join(control, "host-cancelled.json"), "cancelled")) return true;
    return this.outcome !== null &&
      await readRecordingHelperControlFlag(join(control, "normal-stop.marker"), "normal_stop");
  }

  private async pump(): Promise<void> {
    try {
      while (!this.stopped) {
        const event = await this.readNext();
        this.apply(event);
        if (this.failed !== null) throw this.failed;
      }
    } catch (error) {
      throw this.recordFailure(error);
    }
  }

  private async observeProcess(): Promise<void> {
    try {
      const outcome = await this.handle.done;
      this.outcome = outcome;
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        throw new RecordingHelperClientError("HELPER_PROCESS_ERROR");
      }
    } catch (error) {
      throw this.recordFailure(error);
    }
  }

  private recordFailure(error: unknown): RecordingHelperClientError {
    this.failed ??= clientError(error);
    this.mic = failedTrack(this.mic, this.failed.code);
    this.system = failedTrack(this.system, this.failed.code);
    return this.failed;
  }

  private async readNext(): Promise<RecordingHelperEvent> {
    const path = join(this.sessionRoot, "control", "events", `${this.nextEvent}.json`);
    while (true) {
      const event = await readRecordingHelperEvent(path, this.nextEvent);
      if (event !== null) {
        this.nextEvent += 1;
        return event;
      }
      if (this.failed !== null) throw this.failed;
      if (this.outcome !== null) throw new RecordingHelperClientError("HELPER_PROCESS_ERROR");
      await delay(POLL_MS, this.pumpAbort.signal);
    }
  }

  private apply(event: RecordingHelperEvent): void {
    if (event.type === "track_state") this[event.track] = event.value;
    else if (event.type === "helper_ready") {
      if (event.meetingId !== this.meetingId) throw new RecordingHelperProtocolError();
      this.helperReady = true;
      this.mic = event.mic;
      this.system = event.system;
    } else if (event.type === "chunk_closed") {
      this.captureEndUs = Math.max(this.captureEndUs, event.endUs);
    } else if (event.type === "command_applied") {
      if (event.commandId !== this.commandId) throw new RecordingHelperProtocolError();
      this.acknowledgedCommandId = event.commandId;
      this.mic = event.mic;
      this.system = event.system;
      if (event.result === "error") {
        this.failed = new RecordingHelperClientError(event.errorCode ?? "COMMAND_APPLY_FAILED");
      }
    } else if (event.type === "helper_stopped") this.stopped = true;
    else this.failed = new RecordingHelperClientError(event.errorCode);
  }

  private async issue(action: string): Promise<void> {
    if (this.failed !== null) throw this.failed;
    const commandId = this.commandId + 1;
    await writeCommand(join(this.sessionRoot, "control", "commands", `${commandId}.json`), {
      schema_version: 1,
      command_id: commandId,
      action,
    });
    this.commandId = commandId;
    await this.waitFor(
      () => this.failed !== null || this.acknowledgedCommandId >= commandId,
      this.options.commandTimeoutMs,
      "HELPER_COMMAND_TIMEOUT",
    );
    if (this.failed !== null) throw this.failed;
  }

  private async waitFor(
    predicate: () => boolean,
    timeoutMs: number,
    timeoutCode: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!predicate()) {
      if (this.failed !== null) throw this.failed;
      if (signal?.aborted === true) throw new RecordingHelperClientError("CANCELLED_BY_USER");
      if (performance.now() >= deadline) throw new RecordingHelperClientError(timeoutCode);
      await delay(Math.min(POLL_MS, deadline - performance.now()), signal);
    }
  }

  private async waitForCleanExit(): Promise<void> {
    await this.waitFor(() => this.outcome !== null, this.options.terminationTimeoutMs,
      "HELPER_TERMINATION_TIMEOUT");
    if (this.outcome?.exitCode !== 0 || this.outcome.signal !== null) {
      throw new RecordingHelperClientError("HELPER_PROCESS_ERROR");
    }
    await this.waitForTree();
  }

  private async waitForTree(): Promise<void> {
    const exited = await this.handle.waitForExit(AbortSignal.timeout(this.options.terminationTimeoutMs));
    if (!exited) {
      this.handle.terminate();
      throw new RecordingHelperClientError("HELPER_TERMINATION_TIMEOUT");
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.commandTail.then(operation, operation);
    this.commandTail = next.then(() => undefined, () => undefined);
    return next;
  }
}

export class RecordingHelperClient implements RecordingSessionHelperFactory {
  constructor(private readonly options: RecordingHelperClientOptions) {
    assertOptions(options);
  }

  async start(input: {
    readonly layout: RecordingAudioLayout;
    readonly meetingId: string;
    readonly signal: AbortSignal;
  }): Promise<RecordingHelperSession> {
    if (input.signal.aborted) throw new RecordingHelperClientError("CANCELLED_BY_USER");
    const sessionRoot = input.layout.meetingDirectory;
    const handle = this.options.subprocess.spawn({
      argv: [
        "/usr/bin/open", "-n", "-W", this.options.appRoot, "--args",
        sessionRoot, input.meetingId, String(this.options.hostProcessId),
      ],
      cwd: dirname(this.options.appRoot),
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: DIAGNOSTIC_BYTES },
        stderr: { maxBytes: DIAGNOSTIC_BYTES },
      },
      graceMs: this.options.terminationTimeoutMs,
    });
    const active = new ActiveRecordingHelperSession(
      this.options,
      handle,
      sessionRoot,
      input.meetingId,
    );
    try {
      return await active.waitUntilReady(input.signal);
    } catch (error) {
      await active.forceTerminate();
      throw clientError(error);
    }
  }
}
