export type ManagedAudioErrorCode =
  | "FILE_NOT_FOUND"
  | "INVALID_PATH"
  | "UNSUPPORTED_AUDIO_FORMAT"
  | "AUDIO_FILE_TOO_LARGE"
  | "AUDIO_TOO_LONG"
  | "AUDIO_DECODE_FAILED"
  | "AUDIO_RECOVERY_FAILED"
  | "DISK_SPACE_INSUFFICIENT"
  | "ENGINE_FAILURE"
  | "STORAGE_FAILURE"
  | "CANCELLED_BY_USER";

export class ManagedAudioError extends Error {
  constructor(
    readonly code: ManagedAudioErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedAudioError";
  }
}
