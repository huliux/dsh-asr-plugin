export type RuntimeAssetsErrorCode =
  | "DISK_SPACE_INSUFFICIENT"
  | "MODEL_NOT_READY"
  | "MODEL_PACK_INCOMPATIBLE"
  | "MODEL_PACK_INVALID"
  | "STAGE_ABORTED";

export class RuntimeAssetsError extends Error {
  readonly assetId: string | undefined;
  readonly code: RuntimeAssetsErrorCode;

  constructor(code: RuntimeAssetsErrorCode, message: string, assetId?: string) {
    super(message);
    this.name = "RuntimeAssetsError";
    this.code = code;
    this.assetId = assetId;
  }
}
