import { encodeFrame, MAX_FRAME_PAYLOAD_BYTES } from "../dist/worker/framing.js";
import {
  MAX_TOTAL_TEXT_WIRE_BYTES,
  parseRunMessage,
  parseWorkerMessage,
} from "../dist/worker/messages.js";

const DURATION_MS = 14_400_000;
const BLOCK_COUNT = 20_000;
const TEXT_CHARS_PER_BLOCK = 1_250;

function blocks() {
  const text = "x".repeat(TEXT_CHARS_PER_BLOCK);
  return Array.from({ length: BLOCK_COUNT }, (_, seq) => ({
    seq,
    start_ms: seq * 720,
    end_ms: seq * 720 + 719,
    text,
  }));
}

function regions() {
  return Array.from({ length: BLOCK_COUNT }, (_, index) => ({
    start_ms: index * 720,
    end_ms: index * 720 + 719,
  }));
}

function payloadBytes(message) {
  return encodeFrame(message).byteLength - 4;
}

const started = performance.now();
const asrBlocks = blocks();
const speechRegions = regions();
const asrResult = {
  type: "result",
  request_id: "payload-asr",
  kind: "asr",
  base_transcript_version: 0,
  payload: {
    blocks: asrBlocks,
    speech_regions: speechRegions,
    empty_reason: null,
    metrics: { vad_ms: 0, asr_ms: 0, max_rss_bytes: 0 },
  },
};
parseWorkerMessage(asrResult, "asr");
const asrResultBytes = payloadBytes(asrResult);
const diarizationRun = {
  type: "run",
  request_id: "payload-diarization",
  kind: "diarization",
  base_transcript_version: 0,
  payload: {
    audio_path: "/managed/audio.wav",
    duration_ms: DURATION_MS,
    blocks: asrBlocks,
    speech_regions: speechRegions,
  },
};
parseRunMessage(diarizationRun, "diarization");
const diarizationRunBytes = payloadBytes(diarizationRun);
const diarizationResult = {
  type: "result",
  request_id: "payload-diarization",
  kind: "diarization",
  base_transcript_version: 0,
  payload: {
    result_status: "completed",
    result_reason: null,
    segments: asrBlocks.map((block) => ({ ...block, speaker_label: "Speaker A" })),
    warnings: [],
    metrics: {
      fbank_ms: 0,
      embed_ms: 0,
      cluster_ms: 0,
      assign_ms: 0,
      max_rss_bytes: 0,
    },
  },
};
parseWorkerMessage(diarizationResult, "diarization");
const diarizationResultBytes = payloadBytes(diarizationResult);
const sizes = { asrResultBytes, diarizationRunBytes, diarizationResultBytes };
const withinLimit = Object.values(sizes).every((size) => size <= MAX_FRAME_PAYLOAD_BYTES);

console.log(JSON.stringify({
  ok: withinLimit,
  blockCount: BLOCK_COUNT,
  durationMs: DURATION_MS,
  maxFramePayloadBytes: MAX_FRAME_PAYLOAD_BYTES,
  maxTotalTextWireBytes: MAX_TOTAL_TEXT_WIRE_BYTES,
  rssBytes: process.memoryUsage().rss,
  sizes,
  textCharsPerBlock: TEXT_CHARS_PER_BLOCK,
  totalTextChars: BLOCK_COUNT * TEXT_CHARS_PER_BLOCK,
  wallMs: Math.round(performance.now() - started),
}));
if (!withinLimit) process.exitCode = 1;
