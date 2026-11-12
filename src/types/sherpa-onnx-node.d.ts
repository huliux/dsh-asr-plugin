// Ambient types for the bundled sherpa-onnx runtime. The package ships plain
// CommonJS without declarations, so the surface used by the Parakeet engine is
// declared here instead of being inferred from an untyped module.
declare module "sherpa-onnx-node" {
  export interface OfflineFeatureConfig {
    readonly sampleRate?: number;
    readonly featureDim?: number;
  }

  export interface OfflineTransducerModelConfig {
    readonly encoder: string;
    readonly decoder: string;
    readonly joiner: string;
  }

  export interface OfflineModelConfig {
    readonly transducer?: OfflineTransducerModelConfig;
    readonly tokens: string;
    readonly numThreads?: number;
    readonly provider?: string;
    readonly debug?: number;
  }

  export interface OfflineRecognizerConfig {
    readonly featConfig?: OfflineFeatureConfig;
    readonly modelConfig: OfflineModelConfig;
    readonly decodingMethod: string;
  }

  export interface OfflineRecognizerResult {
    readonly text: string;
    readonly tokens: readonly string[];
    readonly timestamps: readonly number[];
    readonly durations?: readonly number[];
  }

  export interface OfflineStream {
    acceptWaveform(input: { readonly samples: Float32Array; readonly sampleRate: number }): void;
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    getResult(stream: OfflineStream): OfflineRecognizerResult;
  }
}
