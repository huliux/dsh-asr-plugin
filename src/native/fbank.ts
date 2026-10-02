import { createRequire } from "node:module";
import { resolve } from "node:path";

import { NativeAdapterError } from "./errors.js";

export interface MelFeatures {
  data: Float32Array;
  dims: readonly [frames: number, melBins: 80];
}

export interface Fbank {
  extract(samples: Float32Array): MelFeatures;
}

interface NativeFbankModule {
  fbank(samples: Float32Array): unknown;
}

function assertFiniteSamples(samples: Float32Array): void {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new NativeAdapterError(
      "NATIVE_INPUT_INVALID",
      "fbank",
      "fbank input must be a non-empty Float32Array",
    );
  }
  for (const sample of samples) {
    if (!Number.isFinite(sample)) {
      throw new NativeAdapterError(
        "NATIVE_INPUT_INVALID",
        "fbank",
        "fbank input must contain only finite samples",
      );
    }
  }
}

function validateFeatures(value: unknown): MelFeatures {
  if (typeof value !== "object" || value === null) return invalidFeatures();
  const { data, dims } = value as { data?: unknown; dims?: unknown };
  if (
    !(data instanceof Float32Array) ||
    !Array.isArray(dims) ||
    dims.length !== 2 ||
    !Number.isSafeInteger(dims[0]) ||
    dims[0] <= 0 ||
    dims[1] !== 80 ||
    data.length !== dims[0] * dims[1] ||
    !data.every(Number.isFinite)
  ) {
    return invalidFeatures();
  }
  return { data: new Float32Array(data), dims: [dims[0], 80] };
}

function invalidFeatures(): never {
  throw new NativeAdapterError(
    "NATIVE_OUTPUT_INVALID",
    "fbank",
    "fbank returned invalid features",
  );
}

function loadModule(binaryPath: string): NativeFbankModule {
  try {
    const value: unknown = createRequire(import.meta.url)(resolve(binaryPath));
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { fbank?: unknown }).fbank !== "function"
    ) {
      throw new Error("fbank export is missing");
    }
    return value as NativeFbankModule;
  } catch (error) {
    throw new NativeAdapterError(
      "NATIVE_LOAD_FAILED",
      "fbank",
      "fbank native module failed to load",
      { cause: error },
    );
  }
}

export function loadFbank(binaryPath: string): Fbank {
  const nativeModule = loadModule(binaryPath);
  return {
    extract(samples) {
      assertFiniteSamples(samples);
      try {
        return validateFeatures(nativeModule.fbank(samples));
      } catch (error) {
        if (error instanceof NativeAdapterError) throw error;
        throw new NativeAdapterError(
          "NATIVE_EXECUTION_FAILED",
          "fbank",
          "fbank native execution failed",
          { cause: error },
        );
      }
    },
  };
}
