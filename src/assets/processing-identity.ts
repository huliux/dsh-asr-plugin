import { createHash } from "node:crypto";
import { modelPackFingerprint, modelSetFingerprint } from "./model-pack.js";
import type { AssetManifest } from "./verify-assets.js";

import type { ProcessingIdentity, ProcessingMode } from "./processing-identity-types.js";
export type { ProcessingIdentity, ProcessingMode } from "./processing-identity-types.js";

export function createProcessingIdentity(
  manifest: AssetManifest,
  manifestFingerprint: string,
  mode: ProcessingMode,
): ProcessingIdentity {
  if (mode !== "base" && mode !== "enhanced") throw new TypeError("Invalid processing mode");
  const fields = {
    mode,
    baseModelFingerprint: modelPackFingerprint(manifest, "base"),
    punctuationModelFingerprint: mode === "enhanced" ? modelPackFingerprint(manifest, "punctuation") : null,
    compatibilityFingerprint: modelSetFingerprint(manifest),
  };
  const engineFingerprint = createHash("sha256")
    .update(JSON.stringify({ manifestFingerprint, ...fields })).digest("hex");
  return Object.freeze({ ...fields, engineFingerprint });
}

export function parseProcessingIdentity(value: unknown): ProcessingIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid processing identity");
  }
  const fields = value as Record<string, unknown>;
  const keys = ["mode", "baseModelFingerprint", "punctuationModelFingerprint",
    "compatibilityFingerprint", "engineFingerprint"];
  const hash = (input: unknown) => typeof input === "string" && /^[0-9a-f]{64}$/.test(input);
  if (Object.keys(fields).length !== keys.length || keys.some((key) => !Object.hasOwn(fields, key)) ||
    (fields.mode !== "base" && fields.mode !== "enhanced") ||
    !hash(fields.baseModelFingerprint) || !hash(fields.compatibilityFingerprint) ||
    !hash(fields.engineFingerprint) || (fields.mode === "base"
      ? fields.punctuationModelFingerprint !== null : !hash(fields.punctuationModelFingerprint))) {
    throw new TypeError("Invalid processing identity");
  }
  return Object.freeze({
    mode: fields.mode,
    baseModelFingerprint: fields.baseModelFingerprint as string,
    punctuationModelFingerprint: fields.punctuationModelFingerprint as string | null,
    compatibilityFingerprint: fields.compatibilityFingerprint as string,
    engineFingerprint: fields.engineFingerprint as string,
  });
}
