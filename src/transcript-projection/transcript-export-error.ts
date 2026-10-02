export type TranscriptProjectionErrorCode =
  | "CANCELLED_BY_USER"
  | "INVALID_INPUT"
  | "TRANSCRIPT_EMPTY"
  | "TRANSCRIPT_NOT_COMMITTED"
  | "EXPORT_PATH_INVALID"
  | "EXPORT_TARGET_EXISTS"
  | "EXPORT_PERMISSION_DENIED"
  | "EXPORT_WRITE_FAILED";

export class TranscriptProjectionError extends Error {
  constructor(readonly code: TranscriptProjectionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscriptProjectionError";
  }
}
