import { resolve } from "node:path";
import * as ort from "onnxruntime-node";

import { VadProcessingError } from "./errors.js";
import {
  VAD_CLASSES,
  VAD_OUTPUT_FRAMES,
  VAD_WINDOW_SAMPLES,
} from "./bounded-vad.js";
import type { VadInferenceModel } from "./bounded-vad.js";

const INPUT_NAME = "input_values";
const OUTPUT_NAME = "logits";

export interface LoadedVadModel extends VadInferenceModel {
  close(): Promise<void>;
}

function loadFailure(message: string, cause?: unknown): VadProcessingError {
  return new VadProcessingError(
    "MODEL_LOAD_FAILED",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function inferenceFailure(message: string, cause?: unknown): VadProcessingError {
  return new VadProcessingError(
    "MODEL_INFERENCE_FAILED",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function assertSessionContract(session: ort.InferenceSession): void {
  if (
    !session.inputNames.includes(INPUT_NAME) ||
    !session.outputNames.includes(OUTPUT_NAME)
  ) {
    throw loadFailure("VAD model I/O contract mismatch");
  }
}

function copyLogits(
  value: ort.OnnxValue | undefined,
  batchWindows: number,
): Float32Array {
  if (
    !(value instanceof ort.Tensor) ||
    !(value.data instanceof Float32Array) ||
    value.dims.length !== 3 ||
    value.dims[0] !== batchWindows ||
    value.dims[1] !== VAD_OUTPUT_FRAMES ||
    value.dims[2] !== VAD_CLASSES
  ) {
    throw inferenceFailure("VAD model returned an invalid logits tensor");
  }
  return new Float32Array(value.data);
}

async function runSession(
  session: ort.InferenceSession,
  input: Float32Array,
  batchWindows: number,
): Promise<Float32Array> {
  const tensor = new ort.Tensor("float32", input, [
    batchWindows,
    1,
    VAD_WINDOW_SAMPLES,
  ]);
  let results: ort.InferenceSession.ReturnType | undefined;
  try {
    results = await session.run({ [INPUT_NAME]: tensor });
    return copyLogits(results[OUTPUT_NAME], batchWindows);
  } catch (error) {
    if (error instanceof VadProcessingError) throw error;
    throw inferenceFailure("VAD ONNX inference failed", error);
  } finally {
    tensor.dispose();
    if (results !== undefined) {
      for (const value of Object.values(results)) value.dispose();
    }
  }
}

export async function loadVadModel(modelPath: string): Promise<LoadedVadModel> {
  let session: ort.InferenceSession | undefined;
  try {
    session = await ort.InferenceSession.create(resolve(modelPath), {
      executionProviders: ["cpu"],
      logSeverityLevel: 3,
      logVerbosityLevel: 0,
    });
    assertSessionContract(session);
  } catch (error) {
    await session?.release().catch(() => undefined);
    if (error instanceof VadProcessingError) throw error;
    throw loadFailure("VAD ONNX model failed to load", error);
  }
  const loadedSession = session;
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      await loadedSession.release();
    },
    async infer(input, batchWindows) {
      if (closed) throw inferenceFailure("VAD model is closed");
      return runSession(loadedSession, input, batchWindows);
    },
  };
}
