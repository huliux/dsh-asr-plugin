import type { ProcessingMode } from "../assets/processing-identity.js";
import { runBoundedVad } from "../asr/bounded-vad.js";
import { createFunAsrRuntimeFactory } from "../asr/funasr/factory.js";
import type {
  FunAsrPunctuator,
  FunAsrRecognizer,
  FunAsrRuntimeFactory,
} from "../asr/funasr/pipeline.js";
import { runFunAsr } from "../asr/funasr/pipeline.js";
import { loadVadModel } from "../asr/vad-model.js";
import type { LoadedVadModel } from "../asr/vad-model.js";
import type { WorkerEntryConfig } from "./entry-config.js";
import { openManagedPcm16Wav, prepareManagedAudioRoot } from "./managed-audio.js";
import type { LoadedWorkerRuntime } from "./worker-server.js";
import type { AsrResultPayload, AsrRunMessage } from "./types.js";
import { stageWorkerFailure } from "./worker-errors.js";
import { loadWorkerAssets, requiredAsset } from "./worker-assets.js";

const ASR_ASSET_IDS = [
  "vad-model",
  "asr-cmvn",
  "asr-config",
  "asr-model",
  "asr-tokens",
  "fbank-native",
  "punc-config",
  "punc-model",
  "punc-tokens",
] as const;

interface AsrComponents {
  readonly mode: ProcessingMode;
  readonly vad: LoadedVadModel;
  readonly recognizer: FunAsrRecognizer;
  readonly loadPunctuator: () => Promise<FunAsrPunctuator>;
}

interface PartialAsrComponents {
  vad?: LoadedVadModel;
  recognizer?: FunAsrRecognizer;
}

function runtimeFactory(
  recognizer: FunAsrRecognizer,
  loadPunctuator: () => Promise<FunAsrPunctuator>,
): FunAsrRuntimeFactory {
  return {
    async loadRecognizer() { return recognizer; },
    loadPunctuator,
  };
}

async function closeComponents(components: PartialAsrComponents): Promise<void> {
  const outcomes = await Promise.allSettled([
    components.vad?.close(),
    components.recognizer?.close(),
  ].filter((operation): operation is Promise<void> => operation !== undefined));
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason as unknown] : []);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "ASR runtime failed to close");
}

async function loadComponents(paths: Readonly<Record<string, string>>, mode: ProcessingMode): Promise<AsrComponents> {
  const partial: PartialAsrComponents = {};
  try {
    partial.vad = await loadVadModel(requiredAsset(paths, "vad-model"));
    const factory = createFunAsrRuntimeFactory({
      asrCmvnPath: requiredAsset(paths, "asr-cmvn"),
      asrConfigPath: requiredAsset(paths, "asr-config"),
      asrModelPath: requiredAsset(paths, "asr-model"),
      asrTokensPath: requiredAsset(paths, "asr-tokens"),
      fbankPath: requiredAsset(paths, "fbank-native"),
      punctuationConfigPath: mode === "base" ? undefined : requiredAsset(paths, "punc-config"),
      punctuationModelPath: mode === "base" ? undefined : requiredAsset(paths, "punc-model"),
      punctuationTokensPath: mode === "base" ? undefined : requiredAsset(paths, "punc-tokens"),
    });
    partial.recognizer = await factory.loadRecognizer();
    return {
      mode,
      vad: partial.vad,
      recognizer: partial.recognizer,
      loadPunctuator: () => factory.loadPunctuator(),
    };
  } catch (error) {
    await closeComponents(partial).catch(() => undefined);
    throw error;
  }
}

function asrPayload(
  vad: Awaited<ReturnType<typeof runBoundedVad>>,
  asr: Awaited<ReturnType<typeof runFunAsr>>,
  asrMs: number,
): AsrResultPayload {
  return {
    blocks: asr.blocks.map((block) => ({
      seq: block.seq,
      start_ms: block.startMs,
      end_ms: block.endMs,
      text: block.text,
    })),
    speech_regions: vad.speechRegions.map((region) => ({
      start_ms: region.startMs,
      end_ms: region.endMs,
    })),
    empty_reason: asr.emptyReason,
    metrics: {
      vad_ms: vad.metrics.vadMs,
      asr_ms: Math.max(0, Math.round(asrMs)),
      max_rss_bytes: process.resourceUsage().maxRSS * 1_024,
    },
  };
}

async function executeAsr(
  run: AsrRunMessage,
  managedRoot: string,
  components: AsrComponents,
  report: Parameters<LoadedWorkerRuntime<"asr">["execute"]>[1],
): Promise<AsrResultPayload> {
  const reader = await openManagedPcm16Wav(
    managedRoot,
    run.payload.audio_path,
    run.payload.duration_ms,
  );
  try {
    await report("vad", 0);
    let vad: Awaited<ReturnType<typeof runBoundedVad>>;
    try {
      vad = await runBoundedVad(reader, components.vad);
    } catch (error) {
      throw stageWorkerFailure(error, "asr", "vad");
    }
    await report("vad", 1);
    await report("asr", 0);
    const started = performance.now();
    let asr: Awaited<ReturnType<typeof runFunAsr>>;
    try {
      asr = await runFunAsr(
        reader,
        vad.asrChunks,
        runtimeFactory(components.recognizer, components.loadPunctuator),
        components.mode,
      );
    } catch (error) {
      throw stageWorkerFailure(error, "asr", "asr");
    }
    const elapsed = performance.now() - started;
    await report("asr", 1);
    return asrPayload(vad, asr, elapsed);
  } finally {
    await reader.close();
  }
}

export async function loadAsrWorkerRuntime(
  config: WorkerEntryConfig,
): Promise<LoadedWorkerRuntime<"asr">> {
  const assets = await loadWorkerAssets(config, ASR_ASSET_IDS);
  const managedRoot = await prepareManagedAudioRoot(config.managedAudioDirectory);
  const components = await loadComponents(assets.paths, config.processing?.identity.mode ?? "enhanced");
  return {
    engineFingerprint: assets.engineFingerprint,
    execute: (run, report) => executeAsr(run, managedRoot, components, report),
    close: () => closeComponents({
      vad: components.vad,
      recognizer: components.recognizer,
    }),
  };
}
