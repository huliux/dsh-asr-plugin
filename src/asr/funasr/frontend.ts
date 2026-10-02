import { FunAsrError } from "./errors.js";

export interface FunAsrCmvn {
  readonly addShift: Float32Array;
  readonly rescale: Float32Array;
}

export interface LfrFeatures {
  readonly data: Float32Array;
  readonly frames: number;
}

function assetMismatch(message: string): never {
  throw new FunAsrError("ASSET_MISMATCH", message);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    assetMismatch(`Invalid FunASR ${name}`);
  }
}

function assertFeatureMatrix(
  inputs: Float32Array,
  frames: number,
  featureDim: number,
): void {
  assertPositiveInteger(featureDim, "feature dimension");
  if (!Number.isSafeInteger(frames) || frames < 0 || inputs.length !== frames * featureDim) {
    assetMismatch("Invalid FunASR feature matrix");
  }
  if (!inputs.every(Number.isFinite)) {
    assetMismatch("FunASR features must be finite");
  }
}

export function applyLfr(
  inputs: Float32Array,
  frames: number,
  featureDim: number,
  lfrM: number,
  lfrN: number,
): LfrFeatures {
  assertFeatureMatrix(inputs, frames, featureDim);
  assertPositiveInteger(lfrM, "LFR window");
  assertPositiveInteger(lfrN, "LFR stride");
  if (frames === 0) return { data: new Float32Array(), frames: 0 };

  const leftPadding = Math.floor((lfrM - 1) / 2);
  const paddedFrames = frames + leftPadding;
  const padded = new Float32Array(paddedFrames * featureDim);
  for (let index = 0; index < leftPadding; index += 1) {
    padded.set(inputs.subarray(0, featureDim), index * featureDim);
  }
  padded.set(inputs, leftPadding * featureDim);
  return stackLfrFrames(padded, frames, featureDim, lfrM, lfrN);
}

function stackLfrFrames(
  padded: Float32Array,
  frames: number,
  featureDim: number,
  lfrM: number,
  lfrN: number,
): LfrFeatures {
  const outputFrames = Math.ceil(frames / lfrN);
  const outputDim = featureDim * lfrM;
  const paddedFrames = padded.length / featureDim;
  const output = new Float32Array(outputFrames * outputDim);
  for (let frame = 0; frame < outputFrames; frame += 1) {
    for (let offset = 0; offset < lfrM; offset += 1) {
      const sourceFrame = Math.min(frame * lfrN + offset, paddedFrames - 1);
      const source = sourceFrame * featureDim;
      output.set(padded.subarray(source, source + featureDim), frame * outputDim + offset * featureDim);
    }
  }
  return { data: output, frames: outputFrames };
}

export function applyCmvn(
  inputs: Float32Array,
  frames: number,
  featureDim: number,
  cmvn: FunAsrCmvn,
): Float32Array {
  assertFeatureMatrix(inputs, frames, featureDim);
  if (cmvn.addShift.length < featureDim || cmvn.rescale.length < featureDim) {
    assetMismatch("FunASR CMVN dimension is too small");
  }
  const output = new Float32Array(inputs.length);
  for (let index = 0; index < inputs.length; index += 1) {
    const dimension = index % featureDim;
    const value = (inputs[index]! + cmvn.addShift[dimension]!) * cmvn.rescale[dimension]!;
    if (!Number.isFinite(value)) assetMismatch("FunASR CMVN produced a non-finite value");
    output[index] = value;
  }
  return output;
}
