import { dirname } from "node:path";

import type { RecordingHelperSignatureInspector } from "../assets/recording-helper-assets.js";
import {
  packagedRecordingHelperLayout,
  verifyRecordingHelperAssets,
} from "../assets/runtime-assets.js";
import type { ResolvedRuntimeAssets } from "../assets/runtime-assets.js";
import type { RecordingAudioLayout } from "../storage/managed-audio-store.js";
import { createDshWorkerSpawner, type DshSubprocessPort } from "../worker/dsh-spawner.js";
import {
  WORKER_READY_TIMEOUT_MS,
  WORKER_TERMINATION_GRACE_MS,
  WORKER_TERMINATION_TIMEOUT_MS,
} from "../worker/timeouts.js";
import { RecordingHelperClient, type RecordingHelperSubprocess } from "./helper-client.js";
import { createPackagedRecordingWorkerLaunch } from "./launch.js";
import type {
  RecordingSessionHelperFactory,
  RecordingSessionWorkerFactory,
} from "./recording-session.js";
import { RecordingWorkerClient } from "./worker-client.js";
import { RecordingPermissionsService } from "./permissions.js";

const HELPER_READY_TIMEOUT_MS = 125_000;
const HELPER_COMMAND_TIMEOUT_MS = 30_000;
const RECORDING_FINALIZE_TIMEOUT_MS = 30_000;

export interface ProductRecordingFactoriesOptions {
  readonly expectedFingerprint: string;
  readonly inspectHelperSignature: RecordingHelperSignatureInspector;
  readonly packageRoot: string;
  readonly runtimeAssets: () => Promise<ResolvedRuntimeAssets>;
  readonly subprocess: DshSubprocessPort & RecordingHelperSubprocess;
}

function createHelperFactory(
  options: ProductRecordingFactoriesOptions,
): RecordingSessionHelperFactory {
  let pending: Promise<RecordingHelperClient> | undefined;
  const resolveClient = () => {
    pending ??= (async () => {
      const layout = packagedRecordingHelperLayout(options.packageRoot);
      const verified = await verifyRecordingHelperAssets({
        ...layout,
        inspectSignature: options.inspectHelperSignature,
      });
      return new RecordingHelperClient({
        appRoot: verified.appRoot,
        commandTimeoutMs: HELPER_COMMAND_TIMEOUT_MS,
        hostProcessId: process.pid,
        readyTimeoutMs: HELPER_READY_TIMEOUT_MS,
        subprocess: options.subprocess,
        terminationTimeoutMs: WORKER_TERMINATION_TIMEOUT_MS,
      });
    })().catch((error) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
  return {
    async start(input) {
      return (await resolveClient()).start(input);
    },
  };
}

function roots(layout: RecordingAudioLayout): { meetingsRoot: string; workRoot: string } {
  return {
    meetingsRoot: dirname(layout.meetingDirectory),
    workRoot: dirname(dirname(layout.workRecordingDirectory)),
  };
}

function createWorkerFactory(
  options: ProductRecordingFactoriesOptions,
): RecordingSessionWorkerFactory {
  const spawner = createDshWorkerSpawner(options.subprocess);
  return {
    async start(input) {
      const assets = await options.runtimeAssets();
      const recordingRoots = roots(input.layout);
      const client = new RecordingWorkerClient({
        expectedFingerprint: options.expectedFingerprint,
        spawner,
        launch: createPackagedRecordingWorkerLaunch({
          ...(assets.processing === undefined ? {} : { processing: assets.processing }),
          modelRoot: assets.modelRoot,
          packagedNativeRoot: assets.packagedNativeRoot,
          manifestPath: assets.manifestPath,
          ...recordingRoots,
          meetingId: input.meetingId,
          runId: input.runId,
          expectedFingerprint: options.expectedFingerprint,
          graceMs: WORKER_TERMINATION_GRACE_MS,
        }),
        readyTimeoutMs: WORKER_READY_TIMEOUT_MS,
        finalizeDeadlineMs: RECORDING_FINALIZE_TIMEOUT_MS,
        terminationTimeoutMs: WORKER_TERMINATION_TIMEOUT_MS,
      });
      return client.start({ signal: input.signal, onWarning: input.onWarning });
    },
  };
}

export function createProductRecordingFactories(options: ProductRecordingFactoriesOptions): {
  readonly helper: RecordingSessionHelperFactory;
  readonly worker: RecordingSessionWorkerFactory;
  readonly permissions: RecordingPermissionsService;
  readonly checkPermissions: (signal?: AbortSignal) => Promise<void>;
} {
  const permissions = new RecordingPermissionsService({ subprocess: options.subprocess,
    resolveApp: async () => (await verifyRecordingHelperAssets({
      ...packagedRecordingHelperLayout(options.packageRoot), inspectSignature: options.inspectHelperSignature,
    })).appRoot });
  return {
    helper: createHelperFactory(options),
    worker: createWorkerFactory(options),
    permissions,
    checkPermissions: signal => permissions.require(signal),
  };
}
