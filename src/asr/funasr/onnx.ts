import { resolve } from "node:path";
import * as ort from "onnxruntime-node";

import { FunAsrError } from "./errors.js";

const SESSION_OPTIONS: ort.InferenceSession.SessionOptions = {
  enableCpuMemArena: false,
  enableMemPattern: false,
  executionMode: "sequential",
  executionProviders: ["cpu"],
  graphOptimizationLevel: "all",
  interOpNumThreads: 1,
  intraOpNumThreads: 2,
  logSeverityLevel: 3,
  logVerbosityLevel: 0,
};

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function createSession(
  modelPath: string,
  inputNames: readonly string[],
  outputNames: readonly string[],
): Promise<ort.InferenceSession> {
  let session: ort.InferenceSession | undefined;
  try {
    session = await ort.InferenceSession.create(resolve(modelPath), SESSION_OPTIONS);
    if (!arraysEqual(session.inputNames, inputNames) || !arraysEqual(session.outputNames, outputNames)) {
      throw new FunAsrError("ASSET_MISMATCH", "FunASR ONNX model I/O contract mismatch");
    }
    return session;
  } catch (error) {
    await session?.release().catch(() => undefined);
    if (error instanceof FunAsrError) throw error;
    throw new FunAsrError("MODEL_LOAD_FAILED", "FunASR ONNX model failed to load", { cause: error });
  }
}

export function disposeResults(results: ort.InferenceSession.ReturnType | undefined): void {
  if (results === undefined) return;
  for (const value of Object.values(results)) value.dispose();
}

export function requireFloatTensor(
  value: ort.OnnxValue | undefined,
  name: string,
): ort.TypedTensor<"float32"> {
  if (
    !(value instanceof ort.Tensor) ||
    value.type !== "float32" ||
    !(value.data instanceof Float32Array) ||
    !value.data.every(Number.isFinite)
  ) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", `FunASR ${name} tensor is invalid`);
  }
  return value as ort.TypedTensor<"float32">;
}

export function requireInt32Tensor(
  value: ort.OnnxValue | undefined,
  name: string,
): ort.TypedTensor<"int32"> {
  if (
    !(value instanceof ort.Tensor) ||
    value.type !== "int32" ||
    !(value.data instanceof Int32Array)
  ) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", `FunASR ${name} tensor is invalid`);
  }
  return value as ort.TypedTensor<"int32">;
}

export function argmaxRows(data: Float32Array, rows: number, columns: number): Int32Array {
  if (
    !Number.isSafeInteger(rows) ||
    !Number.isSafeInteger(columns) ||
    rows < 0 ||
    columns <= 0 ||
    data.length !== rows * columns
  ) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "FunASR logits dimensions are invalid");
  }
  const output = new Int32Array(rows);
  for (let row = 0; row < rows; row += 1) {
    const offset = row * columns;
    let best = 0;
    for (let column = 1; column < columns; column += 1) {
      if (data[offset + column]! > data[offset + best]!) best = column;
    }
    output[row] = best;
  }
  return output;
}
