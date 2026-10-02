import { isAbsolute } from "node:path";
import { parseProcessingIdentity } from "../assets/processing-identity.js";
import type { ProcessingIdentity } from "../assets/processing-identity.js";
import { WorkerRuntimeError } from "./worker-errors.js";

export interface ProcessingLaunch {
  readonly identity: ProcessingIdentity;
  readonly punctuationRoot: string | null;
}

export function parseProcessingLaunch(input: string): ProcessingLaunch {
  try {
    if (input.length > 8_192) throw new TypeError("Processing launch is too large");
    const value: unknown = JSON.parse(input);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError();
    const fields = value as Record<string, unknown>;
    if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields, "identity") ||
      !Object.hasOwn(fields, "punctuationRoot")) throw new TypeError();
    const identity = parseProcessingIdentity(fields.identity);
    const root = fields.punctuationRoot;
    if (identity.mode === "base" ? root !== null
      : typeof root !== "string" || root.length > 4_096 || !isAbsolute(root)) throw new TypeError();
    return Object.freeze({ identity, punctuationRoot: root as string | null });
  } catch {
    throw new WorkerRuntimeError("INVALID_REQUEST", "Worker processing launch is invalid");
  }
}
