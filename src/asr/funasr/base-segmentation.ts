import { FunAsrError } from "./errors.js";
import { appendToken, buildTokenUnits } from "./text.js";
import type { FunAsrSentenceBlock, FunAsrTokenUnit } from "./text.js";
import type { FunAsrChunkDraft } from "./pipeline.js";
import type { SpeechRegion } from "../vad-regions.js";

const TARGET_DURATION_MS = 8_000;
const TARGET_CHARACTERS = 80;
const PAUSE_MS = 600;
const MAX_OUTPUTS = 20_000;

interface RecognizedChunk {
  readonly draft: FunAsrChunkDraft;
  readonly region: SpeechRegion;
}

function chunkUnits({ draft, region }: RecognizedChunk): FunAsrTokenUnit[] {
  if (draft.timestampsMs === null) {
    throw new FunAsrError("MODEL_INFERENCE_FAILED", "Base mode requires token timestamps");
  }
  const units = buildTokenUnits(draft.tokens, draft.timestampsMs,
    draft.tokens.map(() => 1), ["<unk>", "_"], region.startMs, region.endMs).map((unit) => ({ ...unit }));
  let text = "";
  let segmentStart = 0;
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]!;
    const previous = units[index - 1];
    const candidate = appendToken(text, unit.text).trim();
    if (previous && text !== "" && (
      unit.endMs - segmentStart > TARGET_DURATION_MS ||
      Array.from(candidate).length > TARGET_CHARACTERS ||
      unit.startMs - previous.endMs >= PAUSE_MS
    )) {
      previous.breakAfter = true;
      text = "";
    }
    if (text === "") segmentStart = unit.startMs;
    text = appendToken(text, unit.text).trim();
  }
  if (units.length > 0) units[units.length - 1]!.breakAfter = true;
  return units;
}

export function baseTokenUnits(chunks: readonly RecognizedChunk[]): FunAsrTokenUnit[] {
  const units: FunAsrTokenUnit[] = [];
  for (const chunk of chunks) {
    units.push(...chunkUnits(chunk));
    if (units.length > MAX_OUTPUTS) {
      throw new FunAsrError("RESOURCE_LIMIT", "Too many ASR tokens");
    }
  }
  return units;
}

export function baseBlocks(chunks: readonly RecognizedChunk[]): Array<FunAsrSentenceBlock & { seq: number }> {
  const blocks: Array<FunAsrSentenceBlock & { seq: number }> = [];
  for (const chunk of chunks) {
    let text = "";
    let startMs = 0;
    for (const unit of chunkUnits(chunk)) {
      if (text === "") startMs = unit.startMs;
      text = appendToken(text, unit.text).trim();
      if (unit.breakAfter) {
        blocks.push({ seq: blocks.length, startMs, endMs: unit.endMs, text });
        text = "";
        if (blocks.length > MAX_OUTPUTS) {
          throw new FunAsrError("RESOURCE_LIMIT", "Too many ASR blocks");
        }
      }
    }
  }
  return blocks;
}
