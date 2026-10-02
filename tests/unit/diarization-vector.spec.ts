import { describe, expect, it } from "vitest";

import {
  centerFeatures,
  cosineDistance,
  l2Normalize,
  normalizedCentroid,
} from "../../src/diarization/vector.js";

describe("speaker embedding vectors", () => {
  it("逐 Mel 维中心化并保持 finite", () => {
    const features = Float32Array.from([1, 3, 3, 5]);
    centerFeatures(features, 2, 2);
    expect([...features]).toEqual([-1, -1, 1, 1]);
  });

  it("执行 256 维 L2 归一化和归一化质心", () => {
    const first = new Float32Array(256);
    const second = new Float32Array(256);
    first[0] = 3;
    first[1] = 4;
    second[0] = 1;

    const normalized = l2Normalize(first);
    const centroid = normalizedCentroid([normalized, second]);

    expect(normalized[0]).toBeCloseTo(0.6);
    expect(normalized[1]).toBeCloseTo(0.8);
    expect(Math.hypot(...centroid)).toBeCloseTo(1);
  });

  it("使用有方向的 cosine distance，拒绝反向向量等同", () => {
    const first = new Float32Array(256);
    const opposite = new Float32Array(256);
    first[0] = 1;
    opposite[0] = -1;
    expect(cosineDistance(first, opposite)).toBeCloseTo(2);
  });

  it("拒绝错误维度、非有限值与零向量", () => {
    const invalid = new Float32Array(256);
    invalid[3] = Number.NaN;
    for (const operation of [
      () => l2Normalize(new Float32Array(255)),
      () => l2Normalize(invalid),
      () => l2Normalize(new Float32Array(256)),
    ]) {
      expect(operation).toThrow(expect.objectContaining({ code: "MODEL_INFERENCE_FAILED" }));
    }
  });
});
