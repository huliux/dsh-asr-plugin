export type ProcessingMode = "base" | "enhanced";

export interface ProcessingIdentity {
  readonly mode: ProcessingMode;
  readonly baseModelFingerprint: string;
  readonly punctuationModelFingerprint: string | null;
  readonly compatibilityFingerprint: string;
  readonly engineFingerprint: string;
}
