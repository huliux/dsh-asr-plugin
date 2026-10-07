import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ResolvedRuntimeAssets } from "../assets/runtime-assets.js";
import { waitBounded } from "../worker/client-process.js";
import type { WorkerSpawner } from "../worker/process.js";
import { WORKER_READY_TIMEOUT_MS, WORKER_TERMINATION_GRACE_MS, WORKER_TERMINATION_TIMEOUT_MS } from "../worker/timeouts.js";
import { createPackagedRecordingWorkerLaunch } from "./launch.js";
import { RecordingWorkerClient } from "./worker-client.js";
import type { RecordingSessionWorkerFactory } from "./recording-session.js";
import { RecordingModelProcess } from "./model-process.js";

interface RecordingModelWorkerOptions {
  readonly spawner: WorkerSpawner;
  readonly meetingsRoot: string;
  readonly workRoot: string;
  readonly idleTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
}
interface ModelEntry {
  readonly key: string;
  readonly process: RecordingModelProcess;
}

export class RecordingModelWorker {
  private entry: ModelEntry | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private selecting: Promise<unknown> = Promise.resolve();
  private retiring: Promise<void> = Promise.resolve();
  constructor(private readonly options: RecordingModelWorkerOptions) {}

  async prepare(assets: ResolvedRuntimeAssets, signal?: AbortSignal): Promise<void> {
    const entry = await this.ensure(assets, signal);
    this.armIdle(entry);
  }

  factory(assets: ResolvedRuntimeAssets): RecordingSessionWorkerFactory {
    return { start: async input => {
      const entry = await this.ensure(assets, input.signal);
      clearTimeout(this.timer);
      const launch = this.launch(assets, input.meetingId, input.runId);
      const client = new RecordingWorkerClient({ launch,
        expectedFingerprint: assets.engineFingerprint,
        spawner: { spawn: () => entry.process.open(input.meetingId, input.runId) },
        readyTimeoutMs: this.options.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS,
        finalizeDeadlineMs: 30_000, terminationTimeoutMs: WORKER_TERMINATION_TIMEOUT_MS });
      return client.start({ signal: input.signal, onWarning: input.onWarning });
    } };
  }

  async releaseIdle(): Promise<void> {
    await this.selecting.catch(() => undefined);
    if (this.entry !== undefined && !this.entry.process.busy) await this.release(this.entry);
    await this.retiring;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await this.selecting.catch(() => undefined);
    if (this.entry !== undefined) await this.release(this.entry);
    await this.retiring;
  }

  private launch(assets: ResolvedRuntimeAssets, meetingId: string, runId: string) {
    return createPackagedRecordingWorkerLaunch({
      ...(assets.processing === undefined ? {} : { processing: assets.processing }),
      modelRoot: assets.modelRoot, packagedNativeRoot: assets.packagedNativeRoot,
      manifestPath: assets.manifestPath, ...this.options,
      meetingId, runId, expectedFingerprint: assets.engineFingerprint, graceMs: WORKER_TERMINATION_GRACE_MS,
    });
  }

  private async ensure(assets: ResolvedRuntimeAssets, signal?: AbortSignal): Promise<ModelEntry> {
    signal?.throwIfAborted();
    const selected = this.selecting.catch(() => undefined).then(() => this.select(assets, signal));
    this.selecting = selected;
    const entry = await selected;
    try {
      await waitBounded(entry.process.ready, signal ?? new AbortController().signal,
        performance.now() + (this.options.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS), "ready");
      if (this.closed || this.entry !== entry) throw new Error("Recording model preparation was superseded");
      return entry;
    } catch (error) {
      if (!signal?.aborted) await this.release(entry);
      throw error;
    }
  }

  private async select(assets: ResolvedRuntimeAssets, signal?: AbortSignal): Promise<ModelEntry> {
    await this.retiring;
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Recording models are closed");
    const key = JSON.stringify([assets.engineFingerprint, assets.modelRoot,
      assets.manifestPath, assets.packagedNativeRoot, assets.processing]);
    if (this.entry !== undefined && this.entry.key !== key) {
      if (this.entry.process.busy) throw new Error("Recording models are busy");
      await this.release(this.entry);
    }
    return this.entry ?? this.create(assets, key);
  }

  private create(assets: ResolvedRuntimeAssets, key: string): ModelEntry {
    const launch = this.launch(assets, randomUUID(), randomUUID());
    const argv = [...launch.argv]; argv[1] = resolve(launch.cwd, "model-entry.js");
    const handle = this.options.spawner.spawn({ ...launch, argv });
    const entry: ModelEntry = { key, process: new RecordingModelProcess(handle, assets.engineFingerprint,
      () => this.armIdle(entry), () => { if (this.entry === entry) { this.entry = undefined; clearTimeout(this.timer); } }) };
    this.entry = entry;
    const readyTimeout = setTimeout(() => { void this.release(entry).catch(() => undefined); },
      this.options.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS);
    readyTimeout.unref();
    void entry.process.ready.then(() => this.armIdle(entry), () => undefined)
      .finally(() => clearTimeout(readyTimeout));
    return entry;
  }

  private armIdle(entry: ModelEntry): void {
    if (this.closed || this.entry !== entry || entry.process.busy) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.release(entry).catch(() => undefined); }, this.options.idleTimeoutMs ?? 300_000);
    this.timer.unref();
  }

  private async release(entry: ModelEntry): Promise<void> {
    if (this.entry === entry) { this.entry = undefined; clearTimeout(this.timer); }
    const retiring = this.retiring.then(() => entry.process.dispose());
    this.retiring = retiring;
    await retiring;
  }
}
