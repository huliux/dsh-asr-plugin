import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { RecordingHelperAssetError } from "./recording-helper-asset-error.js";

export const RECORDING_HELPER_BUNDLE_IDENTIFIER = "com.bitbook.dsh-asr.recording-helper";
export const RECORDING_HELPER_TEAM_IDENTIFIER = "EXAMPLE123";
export const RECORDING_HELPER_DEVELOPER_IDENTITY =
  "Developer ID Application: Example Publisher (EXAMPLE123)";
export const RECORDING_HELPER_DESIGNATED_REQUIREMENT = [
  `identifier "${RECORDING_HELPER_BUNDLE_IDENTIFIER}"`,
  "anchor apple generic",
  "certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */",
  "certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */",
  `certificate leaf[subject.OU] = ${RECORDING_HELPER_TEAM_IDENTIFIER}`,
].join(" and ");
const SOURCE_REVISION = "44887f62f7b1a69fcc9d23583aa8df8f11898aca";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_RECORDING_HELPER_FILES = 256;
export const MAX_RECORDING_HELPER_BYTES = 128 * 1024 * 1024;

export const RECORDING_HELPER_COMPONENTS = {
  helper: {
    minimumOS: "13.5",
    relativePath: "Contents/MacOS/DSHASRRecordingHelper",
  },
  microphone: {
    minimumOS: "13.5",
    relativePath: "Contents/Helpers/dsh-asr-capture-mic",
  },
  systemAudio: {
    minimumOS: "14.2",
    relativePath: "Contents/Helpers/dsh-asr-capture-system",
  },
} as const;

export type RecordingHelperSigningMode = "ad-hoc" | "developer-id";

export interface RecordingHelperFile {
  readonly byteLength: number;
  readonly relativePath: string;
  readonly sha256: string;
}

export interface RecordingHelperManifest {
  readonly components: typeof RECORDING_HELPER_COMPONENTS;
  readonly files: readonly RecordingHelperFile[];
  readonly product: {
    readonly architecture: "arm64";
    readonly bundleIdentifier: typeof RECORDING_HELPER_BUNDLE_IDENTIFIER;
    readonly designatedRequirement: string | null;
    readonly distribution: "closed-pilot-only" | "public";
    readonly entitlements: {
      readonly app: readonly ["com.apple.security.device.audio-input"];
      readonly microphone: readonly ["com.apple.security.device.audio-input"];
      readonly systemAudio: readonly [];
    };
    readonly hardenedRuntime: true;
    readonly minimumOS: "13.5";
    readonly notarization: "not-verified";
    readonly permissionProbeEligible: boolean;
    readonly signingIdentity: string | null;
    readonly signingMode: RecordingHelperSigningMode;
    readonly systemAudioMinimumOS: "14.2";
    readonly teamIdentifier: string | null;
  };
  readonly schemaVersion: 1;
  readonly source: {
    readonly historicalRepository: "https://github.com/kunji163/clerki.git";
    readonly license: "BSD-2-Clause";
    readonly project: "Bitbook";
    readonly revision: typeof SOURCE_REVISION;
    readonly sourcePath: "audio-native/";
  };
  readonly treeSha256: string;
}

function invalidManifest(): never {
  throw new RecordingHelperAssetError(
    "HELPER_MANIFEST_INVALID",
    "Recording helper manifest is invalid",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => keys.includes(key));
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !isAbsolute(value) &&
    !value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." &&
      part !== "..");
}

export function compareRecordingHelperPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseFile(value: unknown): RecordingHelperFile {
  if (!isRecord(value) ||
    !hasExactKeys(value, ["relativePath", "byteLength", "sha256"]) ||
    !isSafeRelativePath(value.relativePath) ||
    !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 0 ||
    typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    invalidManifest();
  }
  return value as unknown as RecordingHelperFile;
}

function exactJSON(value: unknown, expected: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function validEntitlements(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["app", "microphone", "systemAudio"]) &&
    exactJSON(value.app, ["com.apple.security.device.audio-input"]) &&
    exactJSON(value.microphone, ["com.apple.security.device.audio-input"]) &&
    exactJSON(value.systemAudio, []);
}

function parseProduct(value: unknown): RecordingHelperManifest["product"] {
  if (!isRecord(value) || !hasExactKeys(value, [
    "bundleIdentifier", "architecture", "minimumOS", "systemAudioMinimumOS",
    "distribution", "signingMode", "signingIdentity", "teamIdentifier", "designatedRequirement",
    "permissionProbeEligible", "hardenedRuntime", "notarization", "entitlements",
  ]) || value.bundleIdentifier !== RECORDING_HELPER_BUNDLE_IDENTIFIER ||
    value.architecture !== "arm64" || value.minimumOS !== "13.5" ||
    value.systemAudioMinimumOS !== "14.2" ||
    (value.distribution !== "closed-pilot-only" && value.distribution !== "public") ||
    value.hardenedRuntime !== true || value.notarization !== "not-verified" ||
    !validEntitlements(value.entitlements)) {
    invalidManifest();
  }
  const developerID = value.distribution === "closed-pilot-only" &&
    value.signingMode === "developer-id" &&
    value.signingIdentity === RECORDING_HELPER_DEVELOPER_IDENTITY &&
    value.teamIdentifier === RECORDING_HELPER_TEAM_IDENTIFIER &&
    value.designatedRequirement === RECORDING_HELPER_DESIGNATED_REQUIREMENT &&
    value.permissionProbeEligible === true;
  const adHoc = value.signingMode === "ad-hoc" && value.signingIdentity === null &&
    value.teamIdentifier === null &&
    value.designatedRequirement === null &&
    value.permissionProbeEligible === (value.distribution === "public");
  if (!developerID && !adHoc) invalidManifest();
  return value as unknown as RecordingHelperManifest["product"];
}

export function recordingHelperTreeFingerprint(
  files: readonly RecordingHelperFile[],
): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.relativePath}\0${file.byteLength}\0${file.sha256}\n`);
  }
  return hash.digest("hex");
}

function parseManifest(value: unknown): RecordingHelperManifest {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "source", "product", "components", "treeSha256", "files",
  ]) || value.schemaVersion !== 1 || !isRecord(value.source) ||
    !hasExactKeys(value.source, [
      "project", "historicalRepository", "revision", "sourcePath", "license",
    ]) || value.source.project !== "Bitbook" ||
    value.source.historicalRepository !== "https://github.com/kunji163/clerki.git" ||
    value.source.revision !== SOURCE_REVISION || value.source.sourcePath !== "audio-native/" ||
    value.source.license !== "BSD-2-Clause" ||
    !exactJSON(value.components, RECORDING_HELPER_COMPONENTS) ||
    typeof value.treeSha256 !== "string" || !SHA256_PATTERN.test(value.treeSha256) ||
    !Array.isArray(value.files) || value.files.length === 0 ||
    value.files.length > MAX_RECORDING_HELPER_FILES) {
    invalidManifest();
  }
  const product = parseProduct(value.product);
  const files = value.files.map(parseFile);
  const paths = files.map(({ relativePath }) => relativePath);
  const componentPaths = Object.values(RECORDING_HELPER_COMPONENTS)
    .map(({ relativePath }) => relativePath);
  const totalBytes = files.reduce((total, file) => total + file.byteLength, 0);
  if (new Set(paths).size !== paths.length ||
    !exactJSON(paths, [...paths].sort(compareRecordingHelperPaths)) ||
    componentPaths.some((path) => !paths.includes(path)) ||
    totalBytes > MAX_RECORDING_HELPER_BYTES ||
    recordingHelperTreeFingerprint(files) !== value.treeSha256) {
    invalidManifest();
  }
  return {
    schemaVersion: 1,
    source: value.source as unknown as RecordingHelperManifest["source"],
    product,
    components: RECORDING_HELPER_COMPONENTS,
    treeSha256: value.treeSha256,
    files,
  };
}

export async function readRecordingHelperManifest(path: string): Promise<{
  readonly manifest: RecordingHelperManifest;
  readonly sha256: string;
}> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_MANIFEST_BYTES) {
      invalidManifest();
    }
    const bytes = Buffer.alloc(metadata.size);
    let position = 0;
    while (position < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, position, bytes.byteLength - position, position);
      if (bytesRead === 0) invalidManifest();
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== metadata.dev || after.ino !== metadata.ino ||
      after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) {
      invalidManifest();
    }
    return {
      manifest: parseManifest(JSON.parse(bytes.toString("utf8"))),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof RecordingHelperAssetError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new RecordingHelperAssetError(
        "HELPER_ASSET_MISSING",
        "Recording helper manifest is missing",
      );
    }
    return invalidManifest();
  } finally {
    await handle?.close();
  }
}
