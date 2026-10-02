export type NativeAdapterErrorCode =
  | "NATIVE_EXECUTION_FAILED"
  | "NATIVE_INPUT_INVALID"
  | "NATIVE_LOAD_FAILED"
  | "NATIVE_OUTPUT_INVALID";

export class NativeAdapterError extends Error {
  readonly code: NativeAdapterErrorCode;
  readonly component: "fbank" | "hcluster";

  constructor(
    code: NativeAdapterErrorCode,
    component: "fbank" | "hcluster",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NativeAdapterError";
    this.code = code;
    this.component = component;
  }
}
