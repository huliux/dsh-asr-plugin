import { ModelDownloadController } from "./assets/model-download-controller.js";
import { readModelSettings } from "./assets/model-settings.js";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import { dshHomePath, expandHomePath } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";

import {
  MeetingApplication,
  type StartupReconciliationResult,
} from "./application/meeting-application.js";
import { resolveConfiguredRuntimeAssets, resolveRuntimeAssets } from "./assets/runtime-assets.js";
import type { ResolvedRuntimeAssets } from "./assets/runtime-assets.js";
import { fingerprintAssetManifest } from "./assets/verify-assets.js";
import { createDshRecordingHelperSignatureInspector } from "./assets/recording-helper-signature.js";
import { createProductRecordingFactories } from "./recording/product-factories.js";
import {
  registerRecordingHostRpc,
  type RecordingRpcConnection,
} from "./recording/host-rpc.js";
import { acquireDataRootLease } from "./storage/data-root-lease.js";
import { openManagedAudioStore } from "./storage/managed-audio-store.js";
import {
  openMeetingRepository,
  type MeetingRepository,
} from "./storage/meeting-repository.js";
import { registerMeetingTools } from "./tools/meeting-tools.js";
import { createDshWorkerSpawner } from "./worker/dsh-spawner.js";
import { createPackagedWorkerLaunch } from "./worker/launch.js";
import {
  WORKER_READY_TIMEOUT_MS,
  WORKER_TERMINATION_GRACE_MS,
  WORKER_TERMINATION_TIMEOUT_MS,
  workerRunDeadlineMs,
} from "./worker/timeouts.js";
import type { WorkerKind, WorkerRunMessage } from "./worker/types.js";
import { WorkerClient, type WorkerRunOptions } from "./worker/worker-client.js";
import type { WorkerRunner } from "./worker/worker-pipeline.js";

export const name = "dsh-asr";
export const inject = ["tools", "jobs", "subprocess"];

const DEFAULT_DATA_DIRECTORY = dshHomePath("dsh-asr-plugin");
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL("./assets/manifest.json", import.meta.url));

export interface Config {
  readonly data_dir?: string;
  readonly punctuation_enabled?: boolean;
  readonly hf_download_route?: "direct" | "proxy";
  readonly hf_proxy_url?: string;
  readonly hf_proxy_kind?: "mirror" | "http";
}

export const Config = z.object({
  punctuation_enabled: z.boolean().volatile().description("Enable punctuation for new tasks; requires the optional model pack"),
  hf_download_route: z.union(["direct", "proxy"]).default("proxy").volatile(),
  hf_proxy_url: z.string().default("").volatile(),
  hf_proxy_kind: z.union(["mirror", "http"]).volatile(),
  data_dir: z.string().default(DEFAULT_DATA_DIRECTORY),
});

type ParsedConfig = ReturnType<typeof Config>;

interface RuntimePaths {
  readonly dataRoot: string;
  readonly databasePath: string;
  readonly managedAudioDirectory: string;
}

function configuredDirectory(field: string, value: string | undefined, fallback: string): string {
  const selected = value ?? fallback;
  if (selected.trim().length === 0) throw new Error(`dsh-asr: ${field} must not be empty`);
  return resolve(expandHomePath(selected));
}

function resolveRuntimePaths(config: Pick<Config, "data_dir">): RuntimePaths {
  const dataRoot = configuredDirectory("data_dir", config.data_dir, DEFAULT_DATA_DIRECTORY);
  const databaseDirectory = join(dataRoot, "db");
  return {
    dataRoot,
    databasePath: join(databaseDirectory, "meetings.sqlite3"),
    managedAudioDirectory: join(dataRoot, "meetings"),
  };
}

async function prepareDatabaseDirectory(dataRoot: string): Promise<void> {
  const databaseDirectory = join(dataRoot, "db");
  await mkdir(databaseDirectory, { recursive: true, mode: 0o700 });
  await chmod(databaseDirectory, 0o700);
}

interface HostLifetime {
  downloads: ModelDownloadController | undefined;
  application: MeetingApplication | undefined;
  readonly lease: AsyncDisposable;
  repository: MeetingRepository | undefined;
}

async function disposeHost(lifetime: HostLifetime): Promise<void> {
  try {
    await lifetime.downloads?.dispose();
    if (lifetime.application === undefined) lifetime.repository?.close();
    else await lifetime.application.shutdown();
  } finally {
    await lifetime.lease[Symbol.asyncDispose]();
  }
}

function logReconciliation(context: Context, result: StartupReconciliationResult): void {
  if (result.orphanedRuns > 0 || result.completedDeletions > 0) {
    context.logger("dsh-asr").info(
      `startup reconciled orphaned=${result.orphanedRuns} deleted=${result.completedDeletions}`,
    );
  }
  if (result.failedDeletionIds.length > 0) {
    context.logger("dsh-asr").warn(
      `startup left ${result.failedDeletionIds.length} deletion(s) for retry`,
    );
  }
  if (result.recoveredRecordingIds.length > 0) {
    context.logger("dsh-asr").info(
      `startup recovered ${result.recoveredRecordingIds.length} recording source(s)`,
    );
  }
  if (result.failedRecordingRecoveryIds.length > 0) {
    context.logger("dsh-asr").warn(
      `startup left ${result.failedRecordingRecoveryIds.length} recording source(s) for retry`,
    );
  }
}

function createWorkerRunner(
  context: Context,
  kind: WorkerKind,
  fingerprint: string,
  paths: RuntimePaths,
  runtimeAssets: () => Promise<ResolvedRuntimeAssets>,
): WorkerRunner {
  const spawner = createDshWorkerSpawner(context.subprocess);
  return {
    async run(run: WorkerRunMessage, options?: WorkerRunOptions) {
      const assets = await runtimeAssets();
      const worker = new WorkerClient({
        kind,
        expectedFingerprint: fingerprint,
        spawner,
        launch: createPackagedWorkerLaunch({
          kind,
          ...(assets.processing === undefined ? {} : { processing: assets.processing }),
          modelRoot: assets.modelRoot,
          packagedNativeRoot: assets.packagedNativeRoot,
          manifestPath: assets.manifestPath,
          managedAudioDirectory: paths.managedAudioDirectory,
          graceMs: WORKER_TERMINATION_GRACE_MS,
        }),
        readyTimeoutMs: WORKER_READY_TIMEOUT_MS,
        runDeadlineMs: workerRunDeadlineMs(run.payload.duration_ms),
        terminationTimeoutMs: WORKER_TERMINATION_TIMEOUT_MS,
      });
      return worker.run(run, options);
    },
  };
}

function runtimeAssetsResolver(dataRoot: string): () => Promise<ResolvedRuntimeAssets> {
  let pending: Promise<ResolvedRuntimeAssets> | undefined;
  return () => {
    pending ??= resolveRuntimeAssets({ dataRoot, packageRoot: PACKAGE_ROOT }).catch((error) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

function createRuntimePreparer(context: Context, paths: RuntimePaths) {
  return async () => {
    const punctuationEnabled = (context.fiber.config as ParsedConfig).punctuation_enabled.get();
    const assets = await resolveConfiguredRuntimeAssets({
      dataRoot: paths.dataRoot, packageRoot: PACKAGE_ROOT,
    }, punctuationEnabled);
    const runtimeAssets = async () => assets;
    const fingerprint = assets.engineFingerprint;
    const recording = createProductRecordingFactories({
      expectedFingerprint: fingerprint,
      inspectHelperSignature: createDshRecordingHelperSignatureInspector(context.subprocess),
      packageRoot: PACKAGE_ROOT, runtimeAssets, subprocess: context.subprocess,
    });
    return {
      asr: createWorkerRunner(context, "asr", fingerprint, paths, runtimeAssets),
      diarization: createWorkerRunner(context, "diarization", fingerprint, paths, runtimeAssets),
      engineFingerprint: fingerprint, processingIdentity: assets.processing!.identity,
      recordingWorker: recording.worker,
    };
  };
}

export async function apply(context: Context, config: ParsedConfig): Promise<void> {
  const paths = resolveRuntimePaths(config);
  const lifetime: HostLifetime = {
    downloads: undefined,
    application: undefined,
    lease: await acquireDataRootLease(paths.dataRoot),
    repository: undefined,
  };
  try {
    await prepareDatabaseDirectory(paths.dataRoot);
    const fingerprint = await fingerprintAssetManifest(MANIFEST_PATH);
    const runtimeAssets = runtimeAssetsResolver(paths.dataRoot);
    const audioStore = await openManagedAudioStore({
      dataRoot: paths.dataRoot,
      subprocess: context.subprocess,
    });
    const repository = openMeetingRepository(paths.databasePath);
    lifetime.repository = repository;
    const recording = createProductRecordingFactories({
      expectedFingerprint: fingerprint,
      inspectHelperSignature: createDshRecordingHelperSignatureInspector(context.subprocess),
      packageRoot: PACKAGE_ROOT,
      runtimeAssets,
      subprocess: context.subprocess,
    });
    const application = new MeetingApplication({
      prepareRuntime: createRuntimePreparer(context, paths),
      asr: createWorkerRunner(context, "asr", fingerprint, paths, runtimeAssets),
      audioStore,
      dataRoot: paths.dataRoot,
      diarization: createWorkerRunner(context, "diarization", fingerprint, paths, runtimeAssets),
      engineFingerprint: fingerprint,
      jobs: context.jobs,
      recording,
      repository,
    });
    lifetime.application = application;
    context.on("internal/update", (nextConfig: ParsedConfig, _noSave, next: () => void | Promise<void>) => {
      if (resolveRuntimePaths(nextConfig).dataRoot !== paths.dataRoot) return next();
      context.fiber.config = nextConfig;
    });
    context.effect(() => () => disposeHost(lifetime), "dsh-asr: application lifecycle");
    const reconciliation = await application.reconcileStartup();
    logReconciliation(context, reconciliation);
    registerMeetingTools(context, application);
    const downloads = new ModelDownloadController({ dataRoot: paths.dataRoot, packageRoot: PACKAGE_ROOT,
      jobs: context.jobs, transport: context.subprocess, settings: () => {
        const current = context.fiber.config as ParsedConfig;
        return { route: current.hf_download_route.get(), proxyUrl: current.hf_proxy_url.get(),
          proxyKind: current.hf_proxy_kind.get() ?? (current.hf_proxy_url.get().trim() ? "http" : "mirror") };
      } });
    lifetime.downloads = downloads;
    context.inject(["connection"], (webContext) => {
      const connection = webContext.get("connection") as RecordingRpcConnection;
      webContext.jobs.attachController("dsh-asr-recording-web");
      const removeRpc = registerRecordingHostRpc(connection, application, () => readModelSettings(
        { dataRoot: paths.dataRoot, packageRoot: PACKAGE_ROOT },
        (context.fiber.config as ParsedConfig).punctuation_enabled.get(),
      ), downloads);
      webContext.effect(() => removeRpc, "dsh-asr: recording client RPC");
    });
  } catch (error) {
    await disposeHost(lifetime);
    throw error;
  }
}
