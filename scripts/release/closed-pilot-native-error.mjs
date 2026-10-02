export class ClosedPilotNativeReleaseError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ClosedPilotNativeReleaseError";
    this.code = code;
    if (options.assetId !== undefined) this.assetId = options.assetId;
  }
}
