export type RecordingHelperAssetErrorCode =
  | "HELPER_ADHOC_ONLY"
  | "HELPER_ASSET_INVALID"
  | "HELPER_ASSET_MISSING"
  | "HELPER_HASH_MISMATCH"
  | "HELPER_MANIFEST_INVALID"
  | "HELPER_RUNTIME_MISMATCH"
  | "HELPER_SIGNATURE_IDENTITY_MISMATCH"
  | "HELPER_SIGNATURE_INSPECTION_FAILED"
  | "HELPER_SIGNATURE_INVALID"
  | "HELPER_TREE_MISMATCH";

export class RecordingHelperAssetError extends Error {
  readonly code: RecordingHelperAssetErrorCode;

  constructor(code: RecordingHelperAssetErrorCode, message: string) {
    super(message);
    this.name = "RecordingHelperAssetError";
    this.code = code;
  }
}
