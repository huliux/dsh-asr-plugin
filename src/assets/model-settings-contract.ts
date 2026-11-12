import type { AsrEngine, ProcessingMode } from "./processing-identity-types.js";

export type ModelGroupState = "ready" | "missing" | "invalid";
export interface ModelGroupStatus {
  readonly state: ModelGroupState;
  readonly issues: readonly { readonly id: string; readonly code: string; readonly action: string }[];
}
export interface ModelSettingsStatus {
  readonly engine: AsrEngine;
  readonly mode: ProcessingMode;
  readonly preference: boolean | null;
  readonly inheritedLegacy: boolean;
  readonly selectedReady: boolean;
  readonly base: ModelGroupStatus;
  readonly parakeet: ModelGroupStatus;
  readonly punctuation: ModelGroupStatus;
  readonly native: ModelGroupStatus;
  readonly dataDirectory: string;
}
