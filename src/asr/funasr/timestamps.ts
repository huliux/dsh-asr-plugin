import { FunAsrError } from "./errors.js";

export interface TimestampDecodeOptions {
  readonly beginTimeMs?: number;
  readonly maxTokenDuration?: number;
  readonly totalOffset?: number;
  readonly upsampleRate?: number;
}

function cifWithoutHidden(alphas: Float32Array, threshold: number): Float32Array {
  const output = new Float32Array(alphas.length);
  let integrate = 0;
  for (let index = 0; index < alphas.length; index += 1) {
    integrate += alphas[index]!;
    output[index] = integrate;
    if (integrate >= threshold) integrate -= threshold;
  }
  return output;
}

function peakIndexes(peaks: Float32Array, offset: number): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < peaks.length; index += 1) {
    if (peaks[index]! >= 1 - 1e-4) indexes.push(index + offset);
  }
  return indexes;
}

function resolveFirePlaces(
  alphas: Float32Array | null,
  peaks: Float32Array,
  tokenCount: number,
  offset: number,
): number[] {
  const direct = peakIndexes(peaks, offset);
  if (direct.length === tokenCount + 1 || alphas === null) return direct;
  const scaled = new Float32Array(alphas);
  const sum = scaled.reduce((total, value) => total + value, 0);
  if (!(sum > 0)) return direct;
  const scale = sum / (tokenCount + 1);
  for (let index = 0; index < scaled.length; index += 1) scaled[index]! /= scale;
  return peakIndexes(cifWithoutHidden(scaled, 1 - 1e-4), offset);
}

function assertInputs(
  peaks: Float32Array,
  alphas: Float32Array | null,
  options: TimestampDecodeOptions,
): void {
  const values = [
    options.beginTimeMs ?? 0,
    options.maxTokenDuration ?? 30,
    options.totalOffset ?? -1.5,
    options.upsampleRate ?? 3,
  ];
  if (
    peaks.length === 0 ||
    !peaks.every(Number.isFinite) ||
    (alphas !== null && !alphas.every(Number.isFinite)) ||
    !values.every(Number.isFinite) ||
    (options.upsampleRate ?? 3) <= 0
  ) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "Invalid FunASR timestamp tensors");
  }
}

function tokenIntervals(
  firePlaces: readonly number[],
  maxDuration: number,
  timeRate: number,
): Array<[number, number]> {
  const intervals: Array<[number, number]> = [];
  for (let index = 0; index + 1 < firePlaces.length; index += 1) {
    const start = firePlaces[index]!;
    const next = firePlaces[index + 1]!;
    const end = maxDuration < 0 ? next : Math.min(next, start + maxDuration);
    intervals.push([start * timeRate, Math.max(start * timeRate, end * timeRate)]);
  }
  return intervals;
}

export function decodeBiCifTokenTimestamps(
  rawTokens: readonly string[],
  usCifPeak: Float32Array,
  usAlphas: Float32Array | null = null,
  options: TimestampDecodeOptions = {},
): Array<[number, number]> {
  if (rawTokens.length === 0) return [];
  assertInputs(usCifPeak, usAlphas, options);
  const tokens = rawTokens.at(-1) === "</s>" ? rawTokens.slice(0, -1) : [...rawTokens];
  const offset = options.totalOffset ?? -1.5;
  const fires = resolveFirePlaces(usAlphas, usCifPeak, tokens.length, offset);
  if (fires.length !== tokens.length + 1 || fires.some((value) => !Number.isFinite(value))) return [];

  const timeRate = 60 / 1_000 / (options.upsampleRate ?? 3);
  const intervals = tokenIntervals(fires, options.maxTokenDuration ?? 30, timeRate);
  if (intervals.length > 0) {
    const finalFire = fires.at(-1)!;
    intervals.at(-1)![1] = usCifPeak.length - finalFire > 5
      ? ((usCifPeak.length + finalFire) / 2) * timeRate
      : usCifPeak.length * timeRate;
  }
  const beginSeconds = (options.beginTimeMs ?? 0) / 1_000;
  return intervals.map(([start, end]) => [
    Math.max(0, Math.round((start + beginSeconds) * 1_000)),
    Math.max(1, Math.round((end + beginSeconds) * 1_000)),
  ]);
}
