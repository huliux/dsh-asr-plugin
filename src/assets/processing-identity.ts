import { createHash } from "node:crypto";
import { modelPackFingerprint, modelSetFingerprint } from "./model-pack.js";
import type { AssetManifest } from "./verify-assets.js";

import { ASR_ENGINES } from "./processing-identity-types.js";
import type { AsrEngine, ProcessingIdentity, ProcessingMode } from "./processing-identity-types.js";
export type { AsrEngine, ProcessingIdentity, ProcessingMode } from "./processing-identity-types.js";
export { ASR_ENGINES } from "./processing-identity-types.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

function isEngine(value: unknown): value is AsrEngine {
  return typeof value === "string" && (ASR_ENGINES as readonly string[]).includes(value);
}

/**
 * Parakeet ships a single self-punctuating transducer, so it has one pack and
 * no punctuation pack. The `baseModelFingerprint` field names the recognizer
 * pack of the selected engine in both families.
 */
function recognitionPack(engine: AsrEngine): "base" | "parakeet" {
  return engine === "parakeet" ? "parakeet" : "base";
}

export function createProcessingIdentity(
  manifest: AssetManifest,
  manifestFingerprint: string,
  mode: ProcessingMode,
  engine: AsrEngine = "paraformer",
): ProcessingIdentity {
  if (mode !== "base" && mode !== "enhanced") throw new TypeError("Invalid processing mode");
  if (!isEngine(engine)) throw new TypeError("Invalid ASR engine");
  const fields = {
    mode,
    engine,
    baseModelFingerprint: modelPackFingerprint(manifest, recognitionPack(engine)),
    punctuationModelFingerprint: mode === "enhanced" && engine !== "parakeet"
      ? modelPackFingerprint(manifest, "punctuation") : null,
    compatibilityFingerprint: modelSetFingerprint(manifest),
  };
  const engineFingerprint = createHash("sha256")
    .update(JSON.stringify({ manifestFingerprint, ...fields })).digest("hex");
  return Object.freeze({ ...fields, engineFingerprint });
}

/**
 * Accepts identities recorded before the engine field existed; those rows were
 * always produced by the Paraformer family.
 */
export function parseProcessingIdentity(value: unknown): ProcessingIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid processing identity");
  }
  const fields = value as Record<string, unknown>;
  const legacyKeys = ["mode", "baseModelFingerprint", "punctuationModelFingerprint",
    "compatibilityFingerprint", "engineFingerprint"];
  const keys = ["mode", "engine", "baseModelFingerprint", "punctuationModelFingerprint",
    "compatibilityFingerprint", "engineFingerprint"];
  const legacy = fields.engine === undefined &&
    Object.keys(fields).length === legacyKeys.length &&
    legacyKeys.every((key) => Object.hasOwn(fields, key));
  if (!legacy && (Object.keys(fields).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(fields, key)))) {
    throw new TypeError("Invalid processing identity");
  }
  const hash = (input: unknown) => typeof input === "string" && HASH_PATTERN.test(input);
  const engine = legacy ? "paraformer" : fields.engine;
  const mode = fields.mode;
  if (!isEngine(engine) || (mode !== "base" && mode !== "enhanced") ||
    !hash(fields.baseModelFingerprint) || !hash(fields.compatibilityFingerprint) ||
    !hash(fields.engineFingerprint) ||
    (mode === "base" || engine === "parakeet"
      ? fields.punctuationModelFingerprint !== null
      : !hash(fields.punctuationModelFingerprint))) {
    throw new TypeError("Invalid processing identity");
  }
  return Object.freeze({
    mode,
    engine,
    baseModelFingerprint: fields.baseModelFingerprint as string,
    punctuationModelFingerprint: fields.punctuationModelFingerprint as string | null,
    compatibilityFingerprint: fields.compatibilityFingerprint as string,
    engineFingerprint: fields.engineFingerprint as string,
  });
}
