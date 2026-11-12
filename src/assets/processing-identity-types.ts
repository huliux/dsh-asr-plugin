export type ProcessingMode = "base" | "enhanced";

/**
 * Recognizer family that produced a transcript. Identity is engine-aware so
 * cached results and Worker launches never mix families.
 */
export type AsrEngine = "paraformer" | "parakeet";

export const ASR_ENGINES: readonly AsrEngine[] = Object.freeze(["paraformer", "parakeet"]);

export interface ProcessingIdentity {
  readonly mode: ProcessingMode;
  readonly engine: AsrEngine;
  readonly baseModelFingerprint: string;
  readonly punctuationModelFingerprint: string | null;
  readonly compatibilityFingerprint: string;
  readonly engineFingerprint: string;
}
