import { FunAsrError } from "./errors.js";
import type { FunAsrCmvn } from "./frontend.js";

export interface FunAsrFrontendConfig {
  readonly frameLengthMs: 25;
  readonly frameShiftMs: 10;
  readonly inputSize: 560;
  readonly lfrM: 7;
  readonly lfrN: 6;
  readonly numMels: 80;
  readonly predictorBias: 1;
  readonly sampleRate: 16_000;
  readonly window: "hamming";
}

export interface FunAsrPunctuationConfig {
  readonly punctuationList: readonly ["<unk>", "_", "，", "。", "？", "、"];
  readonly sentenceEndId: 3;
}

const FROZEN_FRONTEND: FunAsrFrontendConfig = {
  frameLengthMs: 25,
  frameShiftMs: 10,
  inputSize: 560,
  lfrM: 7,
  lfrN: 6,
  numMels: 80,
  predictorBias: 1,
  sampleRate: 16_000,
  window: "hamming",
};

const FROZEN_PUNCTUATION = ["<unk>", "_", "，", "。", "？", "、"] as const;
const MAX_TOKEN_COUNT = 300_000;

function mismatch(message: string, cause?: unknown): never {
  throw new FunAsrError(
    "ASSET_MISMATCH",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function parseScalar(raw: string): string | number {
  const value = raw.trim().replace(/^['"]|['"]$/g, "");
  const number = Number(value);
  return value !== "" && Number.isFinite(number) ? number : value;
}

function sectionLines(content: string, section: string): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${section}:`);
  if (start < 0) mismatch(`Missing FunASR ${section} section`);
  const baseIndent = lines[start]!.search(/\S|$/);
  const output: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (line.search(/\S|$/) <= baseIndent) break;
    output.push(line);
  }
  return output;
}

function sectionScalars(content: string, section: string): Map<string, string | number> {
  const values = new Map<string, string | number>();
  for (const line of sectionLines(content, section)) {
    const match = /^\s*([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(line);
    if (match !== null) values.set(match[1]!, parseScalar(match[2]!));
  }
  return values;
}

function sectionList(content: string, section: string, key: string): string[] {
  const lines = sectionLines(content, section);
  const keyIndex = lines.findIndex((line) => line.trim() === `${key}:`);
  if (keyIndex < 0) mismatch(`Missing FunASR ${key} list`);
  const keyIndent = lines[keyIndex]!.search(/\S|$/);
  const values: string[] = [];
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (line.search(/\S|$/) <= keyIndent) break;
    const match = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (match !== null) values.push(String(parseScalar(match[1]!)));
  }
  return values;
}

function rootScalar(content: string, key: string, fallback: number): string | number {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(content);
  return match === null ? fallback : parseScalar(match[1]!);
}

export function parseFunAsrFrontendConfig(content: string): FunAsrFrontendConfig {
  const frontend = sectionScalars(content, "frontend_conf");
  const model = sectionScalars(content, "model_conf");
  const actual = {
    frameLengthMs: frontend.get("frame_length"),
    frameShiftMs: frontend.get("frame_shift"),
    inputSize: rootScalar(content, "input_size", 560),
    lfrM: frontend.get("lfr_m"),
    lfrN: frontend.get("lfr_n"),
    numMels: frontend.get("n_mels"),
    predictorBias: model.get("predictor_bias"),
    sampleRate: frontend.get("fs"),
    window: frontend.get("window"),
  };
  for (const [key, expected] of Object.entries(FROZEN_FRONTEND)) {
    if (actual[key as keyof typeof actual] !== expected) mismatch(`FunASR frontend ${key} drifted`);
  }
  return { ...FROZEN_FRONTEND };
}

export function parseFunAsrPunctuationConfig(content: string): FunAsrPunctuationConfig {
  const model = sectionScalars(content, "model_conf");
  const list = sectionList(content, "model_conf", "punc_list");
  if (
    model.get("sentence_end_id") !== 3 ||
    list.length !== FROZEN_PUNCTUATION.length ||
    list.some((value, index) => value !== FROZEN_PUNCTUATION[index])
  ) {
    mismatch("FunASR punctuation configuration drifted");
  }
  return { punctuationList: [...FROZEN_PUNCTUATION], sentenceEndId: 3 };
}

function parseCmvnVector(content: string, marker: "AddShift" | "Rescale"): Float32Array {
  const expression = new RegExp(
    `<${marker}>[\\s\\S]*?<LearnRateCoef>\\s+\\S+\\s+\\[\\s*([\\s\\S]*?)\\s*\\]`,
  );
  const match = expression.exec(content);
  if (match === null) mismatch(`Missing FunASR ${marker} vector`);
  const values = match[1]!.trim().split(/\s+/).filter(Boolean).map(Number);
  if (values.length !== 560 || !values.every(Number.isFinite)) {
    mismatch(`Invalid FunASR ${marker} vector`);
  }
  return Float32Array.from(values);
}

export function parseFunAsrCmvn(content: string): FunAsrCmvn {
  return {
    addShift: parseCmvnVector(content, "AddShift"),
    rescale: parseCmvnVector(content, "Rescale"),
  };
}

export function parseTokenList(content: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    mismatch("Invalid FunASR token JSON", error);
  }
  if (
    !Array.isArray(value) ||
    value.length < 3 ||
    value.length > MAX_TOKEN_COUNT ||
    value.some((token) => typeof token !== "string" || token === "") ||
    value.at(-1) !== "<unk>" ||
    new Set(value).size !== value.length
  ) {
    mismatch("Invalid FunASR token list");
  }
  return value as string[];
}
