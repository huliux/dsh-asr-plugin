import { describe, expect, it } from "vitest";

import { createOnlineSpeakerLabeler } from "../../src/diarization/online-labeler.js";
import type { SpeakerEmbeddingModel } from "../../src/diarization/meeting-diarizer.js";

const DIMENSIONS = 256;

/** Builds a 256-dimensional embedding with the given leading weights. */
function vec(...weights: number[]): Float32Array {
  const vector = new Float32Array(DIMENSIONS);
  weights.forEach((weight, index) => { vector[index] = weight; });
  return vector;
}

/** Embedding model stub: returns the next queued vector, one per call. */
function model(vectors: readonly (readonly number[])[]): SpeakerEmbeddingModel {
  let index = 0;
  return {
    async close() {},
    async embed() {
      const vector = vectors[index] ?? vectors.at(-1) ?? [];
      index += 1;
      return { embedding: vec(...vector), fbankMs: 1, inferenceMs: 1 };
    },
  };
}

const SPEECH = Float32Array.from([0.1, 0.2, 0.3]);

describe("createOnlineSpeakerLabeler", () => {
  it("keeps one speaker for similar embeddings", async () => {
    const labeler = createOnlineSpeakerLabeler({ embedding: model([[1, 0, 0], [1, 0.02, 0]]) });
    expect(await labeler.label(SPEECH)).toBe("Speaker A");
    expect(await labeler.label(SPEECH)).toBe("Speaker A");
    expect(labeler.speakerCount).toBe(1);
  });

  it("opens a new speaker for a dissimilar embedding", async () => {
    const labeler = createOnlineSpeakerLabeler({ embedding: model([[1, 0, 0], [0, 1, 0]]) });
    expect(await labeler.label(SPEECH)).toBe("Speaker A");
    expect(await labeler.label(SPEECH)).toBe("Speaker B");
    expect(labeler.speakerCount).toBe(2);
  });

  it("reuses an existing speaker when returning to it", async () => {
    const labeler = createOnlineSpeakerLabeler({
      embedding: model([[1, 0, 0], [0, 1, 0], [1, 0, 0]]),
    });
    expect(await labeler.label(SPEECH)).toBe("Speaker A");
    expect(await labeler.label(SPEECH)).toBe("Speaker B");
    expect(await labeler.label(SPEECH)).toBe("Speaker A");
  });

  it("reports UNKNOWN once the speaker limit is reached", async () => {
    const labeler = createOnlineSpeakerLabeler({
      embedding: model([[1, 0, 0], [0, 1, 0], [0, 0, 1]]),
      maxSpeakers: 2,
    });
    expect(await labeler.label(SPEECH)).toBe("Speaker A");
    expect(await labeler.label(SPEECH)).toBe("Speaker B");
    expect(await labeler.label(SPEECH)).toBe("UNKNOWN");
    expect(labeler.speakerCount).toBe(2);
  });

  it("does not label empty audio", async () => {
    const labeler = createOnlineSpeakerLabeler({ embedding: model([[1, 0, 0]]) });
    expect(await labeler.label(new Float32Array(0))).toBeNull();
    expect(labeler.speakerCount).toBe(0);
  });

  it("rejects an invalid distance or speaker limit", () => {
    const embedding = model([[1, 0, 0]]);
    expect(() => createOnlineSpeakerLabeler({ embedding, maxDistance: 0 })).toThrow(TypeError);
    expect(() => createOnlineSpeakerLabeler({ embedding, maxSpeakers: 0 })).toThrow(TypeError);
  });
});
