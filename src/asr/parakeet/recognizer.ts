import { createRequire } from "node:module";
import type { OfflineRecognizer, OfflineRecognizerResult } from "sherpa-onnx-node";
import { FunAsrError } from "../funasr/errors.js";
import type { FunAsrChunkDraft } from "../funasr/pipeline.js";
import { parakeetChunkText } from "./text.js";

const require = createRequire(import.meta.url);

const SAMPLE_RATE = 16_000;
const DEFAULT_THREADS = 2;

export interface ParakeetAssetPaths {
  readonly decoderPath: string;
  readonly encoderPath: string;
  readonly joinerPath: string;
  readonly tokensPath: string;
}

export interface ParakeetRecognizerConfig {
  readonly numThreads?: number;
  readonly paths: ParakeetAssetPaths;
}

export interface ParakeetRecognizer {
  close(): Promise<void>;
  recognize(samples: Float32Array): Promise<FunAsrChunkDraft>;
}

interface SherpaModule {
  readonly OfflineRecognizer: new (config: unknown) => OfflineRecognizer;
}

function loadSherpa(): SherpaModule {
  try {
    return require("sherpa-onnx-node") as SherpaModule;
  } catch (error) {
    throw new FunAsrError("MODEL_LOAD_FAILED", "sherpa-onnx runtime is unavailable", { cause: error });
  }
}

function recognizerConfig(paths: ParakeetAssetPaths, numThreads: number): unknown {
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: paths.encoderPath, decoder: paths.decoderPath, joiner: paths.joinerPath },
      tokens: paths.tokensPath,
      numThreads,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
  };
}

function resultDraft(result: OfflineRecognizerResult, samples: number): FunAsrChunkDraft {
  const durationMs = Math.max(1, Math.round((samples / SAMPLE_RATE) * 1_000));
  const text = parakeetChunkText({
    tokens: result.tokens ?? [],
    timestamps: result.timestamps ?? [],
  }, durationMs);
  return {
    featureFrames: Math.max(1, Math.round(samples / 160)),
    frontendMs: 0,
    inferenceMs: 0,
    puncInput: text.puncInput,
    punctuation: text.punctuation,
    rawText: text.rawText,
    timestampsMs: text.timestampsMs,
    tokenCount: text.tokens.length,
    tokens: text.tokens,
  };
}

/**
 * Loads the transducer recognizer once per Worker and reuses it for every
 * chunk. NeMo v3 checkpoints emit casing and punctuation, so no separate
 * punctuator is loaded for this engine.
 */
export async function loadParakeetRecognizer(
  config: ParakeetRecognizerConfig,
): Promise<ParakeetRecognizer> {
  const sherpa = loadSherpa();
  let recognizer: OfflineRecognizer;
  try {
    recognizer = new sherpa.OfflineRecognizer(
      recognizerConfig(config.paths, config.numThreads ?? DEFAULT_THREADS),
    );
  } catch (error) {
    throw new FunAsrError("MODEL_LOAD_FAILED", "Parakeet recognizer failed to load", { cause: error });
  }
  return {
    async close() {
      return Promise.resolve();
    },
    async recognize(samples: Float32Array): Promise<FunAsrChunkDraft> {
      if (!(samples instanceof Float32Array) || samples.length === 0) {
        throw new FunAsrError("MODEL_INFERENCE_FAILED", "Parakeet received empty audio");
      }
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      const started = performance.now();
      let result: OfflineRecognizerResult;
      try {
        recognizer.decode(stream);
        result = recognizer.getResult(stream);
      } catch (error) {
        throw new FunAsrError("MODEL_INFERENCE_FAILED", "Parakeet recognition failed", { cause: error });
      }
      const inferenceMs = performance.now() - started;
      return { ...resultDraft(result, samples.length), inferenceMs };
    },
  };
}
