import { FunAsrError } from "./errors.js";
import type { FunAsrRuntimeFactory } from "./pipeline.js";
import { loadFunAsrPunctuator } from "./punctuator.js";
import { loadFunAsrRecognizer } from "./recognizer.js";

export interface FunAsrAssetPaths {
  readonly asrCmvnPath: string;
  readonly asrConfigPath: string;
  readonly asrModelPath: string;
  readonly asrTokensPath: string;
  readonly fbankPath: string;
  readonly punctuationConfigPath?: string | undefined;
  readonly punctuationModelPath?: string | undefined;
  readonly punctuationTokensPath?: string | undefined;
}

export function createFunAsrRuntimeFactory(paths: FunAsrAssetPaths): FunAsrRuntimeFactory {
  return {
    async loadPunctuator() {
      if (paths.punctuationConfigPath === undefined || paths.punctuationModelPath === undefined ||
        paths.punctuationTokensPath === undefined) {
        throw new FunAsrError("MODEL_LOAD_FAILED", "Enhanced mode requires punctuation assets");
      }
      return loadFunAsrPunctuator({
        configPath: paths.punctuationConfigPath,
        modelPath: paths.punctuationModelPath,
        tokensPath: paths.punctuationTokensPath,
      });
    },
    async loadRecognizer() {
      return loadFunAsrRecognizer({
        cmvnPath: paths.asrCmvnPath,
        configPath: paths.asrConfigPath,
        fbankPath: paths.fbankPath,
        modelPath: paths.asrModelPath,
        tokensPath: paths.asrTokensPath,
      });
    },
  };
}
