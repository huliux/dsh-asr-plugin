import type { ProcessingIdentity } from "../assets/processing-identity.js";

export const PROCESSING_IDENTITY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["base", "enhanced"], required: true },
    base_model_fingerprint: { type: "string", required: true },
    punctuation_model_fingerprint: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
    compatibility_fingerprint: { type: "string", required: true },
    engine_fingerprint: { type: "string", required: true },
  },
} as const;

export function processingIdentityValue(identity: ProcessingIdentity) {
  return { mode: identity.mode,
    base_model_fingerprint: identity.baseModelFingerprint,
    punctuation_model_fingerprint: identity.punctuationModelFingerprint,
    compatibility_fingerprint: identity.compatibilityFingerprint,
    engine_fingerprint: identity.engineFingerprint };
}
