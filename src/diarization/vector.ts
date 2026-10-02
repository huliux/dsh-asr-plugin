import { DiarizationError } from "./errors.js";

export const SPEAKER_EMBEDDING_DIMENSIONS = 256;

function inferenceFailure(message: string): never {
  throw new DiarizationError("MODEL_INFERENCE_FAILED", message);
}

function assertVector(vector: Float32Array): void {
  if (
    !(vector instanceof Float32Array) ||
    vector.length !== SPEAKER_EMBEDDING_DIMENSIONS ||
    !vector.every(Number.isFinite)
  ) {
    inferenceFailure("Speaker embedding must be a finite 256-dimensional vector");
  }
}

function magnitude(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

export function l2Normalize(vector: Float32Array): Float32Array {
  assertVector(vector);
  const norm = magnitude(vector);
  if (!Number.isFinite(norm) || norm <= Number.EPSILON) {
    inferenceFailure("Speaker embedding has zero magnitude");
  }
  return Float32Array.from(vector, (value) => value / norm);
}

export function normalizedCentroid(embeddings: readonly Float32Array[]): Float32Array {
  if (embeddings.length === 0) inferenceFailure("Speaker centroid requires embeddings");
  const centroid = new Float32Array(SPEAKER_EMBEDDING_DIMENSIONS);
  for (const embedding of embeddings) {
    assertVector(embedding);
    for (let index = 0; index < centroid.length; index += 1) {
      centroid[index]! += embedding[index]! / embeddings.length;
    }
  }
  return l2Normalize(centroid);
}

export function cosineDistance(first: Float32Array, second: Float32Array): number {
  assertVector(first);
  assertVector(second);
  const firstNorm = magnitude(first);
  const secondNorm = magnitude(second);
  if (firstNorm <= Number.EPSILON || secondNorm <= Number.EPSILON) {
    inferenceFailure("Speaker embedding has zero magnitude");
  }
  let dot = 0;
  for (let index = 0; index < first.length; index += 1) {
    dot += first[index]! * second[index]!;
  }
  const similarity = Math.max(-1, Math.min(1, dot / (firstNorm * secondNorm)));
  return 1 - similarity;
}

export function centerFeatures(
  features: Float32Array,
  frames: number,
  melBins: number,
): void {
  if (
    !Number.isSafeInteger(frames) ||
    !Number.isSafeInteger(melBins) ||
    frames <= 0 ||
    melBins <= 0 ||
    features.length !== frames * melBins ||
    !features.every(Number.isFinite)
  ) {
    inferenceFailure("Speaker fbank features are invalid");
  }
  for (let mel = 0; mel < melBins; mel += 1) {
    let mean = 0;
    for (let frame = 0; frame < frames; frame += 1) mean += features[frame * melBins + mel]!;
    mean /= frames;
    for (let frame = 0; frame < frames; frame += 1) features[frame * melBins + mel]! -= mean;
  }
}
