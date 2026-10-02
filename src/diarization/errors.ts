export type DiarizationErrorCode =
  | "ASSET_MISMATCH"
  | "INPUT_INVALID"
  | "MODEL_INFERENCE_FAILED"
  | "MODEL_LOAD_FAILED"
  | "NATIVE_LOAD_FAILED"
  | "NATIVE_FAILURE"
  | "RESOURCE_LIMIT";

export class DiarizationError extends Error {
  readonly code: DiarizationErrorCode;

  constructor(code: DiarizationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiarizationError";
    this.code = code;
  }
}
