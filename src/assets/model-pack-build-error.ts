export type ModelPackBuildErrorCode =
  | "MODEL_PACK_BUILD_INVALID"
  | "MODEL_PACK_OUTPUT_EXISTS";

export class ModelPackBuildError extends Error {
  readonly code: ModelPackBuildErrorCode;

  constructor(code: ModelPackBuildErrorCode, message: string) {
    super(message);
    this.name = "ModelPackBuildError";
    this.code = code;
  }
}

export function failModelPackBuildInvalid(message: string): never {
  throw new ModelPackBuildError("MODEL_PACK_BUILD_INVALID", message);
}

export function fileSystemErrorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
