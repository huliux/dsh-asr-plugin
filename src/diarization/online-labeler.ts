import type { SpeakerEmbeddingModel } from "./meeting-diarizer.js";
import { cosineDistance, l2Normalize } from "./vector.js";

/** Below this distance a segment joins an existing speaker, matching the final diarizer. */
export const ONLINE_MAX_CENTROID_DISTANCE = 0.7;
/** Live transcription never grows past this many speakers; the rest report UNKNOWN. */
export const ONLINE_MAX_SPEAKERS = 8;

export interface OnlineSpeakerLabelerOptions {
  readonly embedding: SpeakerEmbeddingModel;
  readonly maxDistance?: number;
  readonly maxSpeakers?: number;
}

export interface OnlineSpeakerLabeler {
  /** Labels one segment of speech; short or ambiguous audio stays unlabeled. */
  label(samples: Float32Array): Promise<string | null>;
  readonly speakerCount: number;
}

function speakerName(index: number): string {
  let value = index + 1;
  let suffix = "";
  while (value > 0) {
    value -= 1;
    suffix = String.fromCharCode(65 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return `Speaker ${suffix}`;
}

interface SpeakerCentroid {
  readonly samples: Float32Array;
  readonly sums: Float32Array;
  count: number;
}

/**
 * Incremental speaker clustering for the live transcript.
 *
 * The final transcript clusters every segment after the recording ends, which
 * cannot drive a preview. This labeler keeps running centroids instead: a new
 * segment joins the nearest speaker when the cosine distance is small enough,
 * and otherwise opens a new one. Labels stay stable across draft revisions
 * because the state lives for the whole recording.
 */
export function createOnlineSpeakerLabeler(options: OnlineSpeakerLabelerOptions): OnlineSpeakerLabeler {
  const maxDistance = options.maxDistance ?? ONLINE_MAX_CENTROID_DISTANCE;
  const maxSpeakers = options.maxSpeakers ?? ONLINE_MAX_SPEAKERS;
  if (!(maxDistance > 0 && maxDistance <= 2)) throw new TypeError("Speaker distance is invalid");
  if (!Number.isSafeInteger(maxSpeakers) || maxSpeakers < 1 || maxSpeakers > 26) {
    throw new TypeError("Speaker limit is invalid");
  }
  const centroids: SpeakerCentroid[] = [];
  return {
    get speakerCount() { return centroids.length; },
    async label(samples) {
      if (samples.length === 0) return null;
      const { embedding } = await options.embedding.embed(samples);
      const normalized = l2Normalize(embedding);
      let best = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const [index, centroid] of centroids.entries()) {
        const distance = cosineDistance(normalized, centroid.samples);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      if (best >= 0 && bestDistance <= maxDistance) {
        const centroid = centroids[best]!;
        for (let index = 0; index < centroid.sums.length; index += 1) {
          centroid.sums[index]! += normalized[index] ?? 0;
        }
        centroid.count += 1;
        // Re-normalize the running mean so the next comparison stays on the unit sphere.
        centroid.samples.set(l2Normalize(centroid.sums));
        return speakerName(best);
      }
      if (centroids.length >= maxSpeakers) return "UNKNOWN";
      centroids.push({ samples: normalized.slice(), sums: normalized.slice(), count: 1 });
      return speakerName(centroids.length - 1);
    },
  };
}
