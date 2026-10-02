import { resolve } from "node:path";
import * as ort from "onnxruntime-node";

import { NativeAdapterError } from "../native/errors.js";
import { loadFbank } from "../native/fbank.js";
import type { Fbank } from "../native/fbank.js";
import { DiarizationError } from "./errors.js";
import type { SpeakerEmbeddingModel, SpeakerEmbeddingOutput } from "./meeting-diarizer.js";
import { centerFeatures, l2Normalize } from "./vector.js";

const INPUT_NAME = "feats";
const OUTPUT_NAME = "embs";
const MEL_BINS = 80;
const MIN_SAMPLES = 1_600;
const MAX_SAMPLES = 9 * 16_000;
const PCM16_SCALE = 32_768;

export interface SpeakerEmbeddingModelPaths {
  readonly fbankPath: string;
  readonly modelPath: string;
}

function loadFailure(message: string, cause?: unknown): DiarizationError {
  return new DiarizationError(
    "MODEL_LOAD_FAILED",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function inferenceFailure(message: string, cause?: unknown): DiarizationError {
  return new DiarizationError(
    "MODEL_INFERENCE_FAILED",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function assertSamples(samples: Float32Array): void {
  if (
    !(samples instanceof Float32Array) ||
    samples.length < MIN_SAMPLES ||
    samples.length > MAX_SAMPLES ||
    !samples.every(Number.isFinite)
  ) {
    throw inferenceFailure("Speaker embedding audio input is invalid");
  }
}

function prepareFeatures(fbank: Fbank, samples: Float32Array): {
  readonly data: Float32Array;
  readonly frames: number;
} {
  assertSamples(samples);
  const amplified = Float32Array.from(samples, (sample) => sample * PCM16_SCALE);
  const features = fbank.extract(amplified);
  centerFeatures(features.data, features.dims[0], features.dims[1]);
  return { data: features.data, frames: features.dims[0] };
}

function parseEmbedding(value: ort.OnnxValue | undefined): Float32Array {
  if (
    !(value instanceof ort.Tensor) ||
    value.type !== "float32" ||
    !(value.data instanceof Float32Array) ||
    value.dims.length !== 2 ||
    value.dims[0] !== 1 ||
    value.dims[1] !== 256 ||
    value.data.length !== 256 ||
    !value.data.every(Number.isFinite)
  ) {
    throw inferenceFailure("Speaker embedding ONNX output is invalid");
  }
  return l2Normalize(new Float32Array(value.data));
}

async function infer(
  session: ort.InferenceSession,
  features: { readonly data: Float32Array; readonly frames: number },
): Promise<Float32Array> {
  const input = new ort.Tensor("float32", features.data, [1, features.frames, MEL_BINS]);
  let results: ort.InferenceSession.ReturnType | undefined;
  try {
    results = await session.run({ [INPUT_NAME]: input });
    return parseEmbedding(results[OUTPUT_NAME]);
  } catch (error) {
    if (error instanceof DiarizationError) throw error;
    throw inferenceFailure("Speaker embedding ONNX inference failed", error);
  } finally {
    input.dispose();
    if (results !== undefined) {
      for (const value of Object.values(results)) value.dispose();
    }
  }
}

async function createSession(modelPath: string): Promise<ort.InferenceSession> {
  let session: ort.InferenceSession | undefined;
  try {
    session = await ort.InferenceSession.create(resolve(modelPath), {
      enableCpuMemArena: false,
      enableMemPattern: false,
      executionMode: "sequential",
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      interOpNumThreads: 1,
      intraOpNumThreads: 2,
      logSeverityLevel: 3,
      logVerbosityLevel: 0,
    });
    if (
      session.inputNames.length !== 1 ||
      session.inputNames[0] !== INPUT_NAME ||
      session.outputNames.length !== 1 ||
      session.outputNames[0] !== OUTPUT_NAME
    ) {
      throw new DiarizationError("ASSET_MISMATCH", "Speaker embedding model I/O contract drifted");
    }
    return session;
  } catch (error) {
    await session?.release().catch(() => undefined);
    if (error instanceof DiarizationError) throw error;
    throw loadFailure("Speaker embedding ONNX model failed to load", error);
  }
}

function loadNativeFbank(path: string): Fbank {
  try {
    return loadFbank(path);
  } catch (error) {
    throw new DiarizationError("NATIVE_LOAD_FAILED", "Speaker fbank failed to load", {
      cause: error,
    });
  }
}

async function embed(
  fbank: Fbank,
  session: ort.InferenceSession,
  samples: Float32Array,
): Promise<SpeakerEmbeddingOutput> {
  try {
    const fbankStarted = performance.now();
    const features = prepareFeatures(fbank, samples);
    const fbankMs = performance.now() - fbankStarted;
    const inferenceStarted = performance.now();
    const embedding = await infer(session, features);
    return { embedding, fbankMs, inferenceMs: performance.now() - inferenceStarted };
  } catch (error) {
    if (error instanceof DiarizationError) throw error;
    if (error instanceof NativeAdapterError) {
      throw new DiarizationError(
        "NATIVE_FAILURE",
        "Speaker fbank execution failed",
        { cause: error },
      );
    }
    throw inferenceFailure("Speaker embedding extraction failed", error);
  }
}

export async function loadSpeakerEmbeddingModel(
  paths: SpeakerEmbeddingModelPaths,
): Promise<SpeakerEmbeddingModel> {
  const fbank = loadNativeFbank(paths.fbankPath);
  const session = await createSession(paths.modelPath);
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      await session.release();
    },
    async embed(samples) {
      if (closed) throw inferenceFailure("Speaker embedding model is closed");
      return embed(fbank, session, samples);
    },
  };
}
