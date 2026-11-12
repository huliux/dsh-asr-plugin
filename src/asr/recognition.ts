import type { AsrEngine, ProcessingMode } from "../assets/processing-identity.js";
import type { FunAsrPunctuator, FunAsrRecognizer } from "./funasr/pipeline.js";
import { createFunAsrRuntimeFactory } from "./funasr/factory.js";
import { loadParakeetRecognizer } from "./parakeet/recognizer.js";
import { WorkerRuntimeError } from "../worker/worker-errors.js";

/**
 * Recognizer weights are family-specific; the shared acoustic assets (VAD,
 * speaker embedding) are language agnostic and belong to no engine.
 */
export function recognitionAssetIds(engine: AsrEngine): readonly string[] {
  return engine === "parakeet"
    ? ["parakeet-encoder", "parakeet-decoder", "parakeet-joiner", "parakeet-tokens"]
    : ["asr-cmvn", "asr-config", "asr-model", "asr-tokens"];
}

/**
 * Parakeet is self-punctuating, so it never loads the punctuation pack.
 */
export function punctuationAssetIds(mode: ProcessingMode, engine: AsrEngine): readonly string[] {
  return mode === "enhanced" && engine !== "parakeet"
    ? ["punc-config", "punc-model", "punc-tokens"] : [];
}

export interface EnginePaths {
  readonly asrCmvnPath: string;
  readonly asrConfigPath: string;
  readonly asrModelPath: string;
  readonly asrTokensPath: string;
  readonly fbankPath: string;
  readonly punctuationConfigPath?: string | undefined;
  readonly punctuationModelPath?: string | undefined;
  readonly punctuationTokensPath?: string | undefined;
  readonly parakeetDecoderPath: string;
  readonly parakeetEncoderPath: string;
  readonly parakeetJoinerPath: string;
  readonly parakeetTokensPath: string;
}

export interface LoadedRecognitionEngine {
  readonly engine: AsrEngine;
  readonly recognizer: FunAsrRecognizer;
  readonly loadPunctuator: (() => Promise<FunAsrPunctuator>) | undefined;
}

/**
 * Loads the recognizer of the selected family once per Worker. The returned
 * punctuator loader is undefined for self-punctuating engines.
 */
export async function loadRecognitionEngine(
  engine: AsrEngine,
  paths: EnginePaths,
): Promise<LoadedRecognitionEngine> {
  if (engine === "parakeet") {
    const recognizer = await loadParakeetRecognizer({
      paths: {
        decoderPath: paths.parakeetDecoderPath,
        encoderPath: paths.parakeetEncoderPath,
        joinerPath: paths.parakeetJoinerPath,
        tokensPath: paths.parakeetTokensPath,
      },
    });
    return { engine, recognizer, loadPunctuator: undefined };
  }
  const factory = createFunAsrRuntimeFactory({
    asrCmvnPath: paths.asrCmvnPath,
    asrConfigPath: paths.asrConfigPath,
    asrModelPath: paths.asrModelPath,
    asrTokensPath: paths.asrTokensPath,
    fbankPath: paths.fbankPath,
    punctuationConfigPath: paths.punctuationConfigPath,
    punctuationModelPath: paths.punctuationModelPath,
    punctuationTokensPath: paths.punctuationTokensPath,
  });
  const load = factory.loadPunctuator;
  return {
    engine,
    recognizer: await factory.loadRecognizer(),
    loadPunctuator: load === undefined ? undefined : () => load(),
  };
}

export function requireEnginePath(
  paths: Readonly<Record<string, string>>,
  id: string,
): string {
  const path = paths[id];
  if (path === undefined) {
    throw new WorkerRuntimeError("ASSET_MISMATCH", "Required Worker asset is missing");
  }
  return path;
}
