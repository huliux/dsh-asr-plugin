export type VadProcessingErrorCode =
  | "MODEL_INFERENCE_FAILED"
  | "MODEL_LOAD_FAILED"
  | "RESOURCE_LIMIT";

export class VadProcessingError extends Error {
  readonly code: VadProcessingErrorCode;

  constructor(
    code: VadProcessingErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VadProcessingError";
    this.code = code;
  }
}
