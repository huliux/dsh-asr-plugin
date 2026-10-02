export type ClosedPilotNativeReleaseCode =
  | "RELEASE_BINARY_MISMATCH"
  | "RELEASE_BUILD_FAILED"
  | "RELEASE_INPUT_INVALID"
  | "RELEASE_OUTPUT_NOT_CLEAN"
  | "RELEASE_PACK_INVALID"
  | "RELEASE_POLICY_MISMATCH";

export class ClosedPilotNativeReleaseError extends Error {
  readonly assetId?: string;
  readonly code: ClosedPilotNativeReleaseCode;
}

export interface MaterializeClosedPilotNativesOptions {
  readonly repositoryRoot: string;
}

export interface NativeInventoryEntry {
  readonly byteLength: number;
  readonly path: string;
  readonly sha256: string;
}

export interface ClosedPilotNativeReleaseReport {
  readonly assets: readonly NativeInventoryEntry[];
}

export function materializeClosedPilotNatives(
  options: MaterializeClosedPilotNativesOptions,
): Promise<ClosedPilotNativeReleaseReport>;

export interface VerifyClosedPilotPackInventoryOptions {
  readonly packedPaths: readonly string[];
  readonly repositoryRoot: string;
}

export function verifyClosedPilotPackInventory(
  options: VerifyClosedPilotPackInventoryOptions,
): Promise<ClosedPilotNativeReleaseReport>;

export function verifyPackedFbankDisclosure(
  options: { readonly packageRoot: string },
): Promise<{ readonly assetId: "fbank-native"; readonly disclosureFiles: number }>;

export interface VerifyPackedExecutableModesOptions {
  readonly executablePaths: readonly string[];
  readonly packageRoot: string;
}

export const CLOSED_PILOT_EXECUTABLE_PATHS: readonly string[];

export function verifyPackedExecutableModes(
  options: VerifyPackedExecutableModesOptions,
): Promise<{ readonly executablePaths: readonly string[] }>;
