import type { ClosedRecordingChunks } from "../audio/closed-recording-chunks.js";
import {
  renderRecordingWindow,
  type RecordingTimeline,
} from "../audio/recording-timeline.js";
import { PCM_SAMPLE_RATE } from "../audio/wav-reader.js";
import { parseRecordingWorkerMessage } from "./worker-messages.js";
import type {
  RecordingDraftSegment,
  RecordingRevisionMessage,
} from "./worker-types.js";

const CADENCE_FRAMES = PCM_SAMPLE_RATE * 5;
const OVERLAP_FRAMES = PCM_SAMPLE_RATE * 3;
const OVERLAP_MILLISECONDS = 3_000;
const MAX_WINDOW_UNITS = 20_000;
const MAX_SEGMENTS = 20_000;
const MAX_TEXT_LENGTH = 20_000;
const TARGET_SEGMENT_LENGTH = 1_000;

export class RecordingDraftResourceError extends Error {
  readonly code = "RESOURCE_LIMIT" as const;

  constructor(message: string) {
    super(message);
    this.name = "RecordingDraftResourceError";
  }
}

export interface RecordingDraftUnit {
  readonly breakAfter: boolean;
  readonly endMs: number;
  readonly startMs: number;
  readonly text: string;
}

export type RecordingDraftRecognizer = (
  samples: Float32Array,
) => Promise<readonly RecordingDraftUnit[]>;

export interface RecordingDraftEngineOptions {
  readonly chunks: ClosedRecordingChunks;
  readonly recognize: RecordingDraftRecognizer;
  readonly now?: () => number;
}

interface DraftPlan {
  readonly boundaryFrame: number;
  readonly endFrame: number;
  readonly reset: boolean;
  readonly startFrame: number;
}

function millisecondsForFrames(frames: number): number {
  return Math.ceil((frames * 1_000) / PCM_SAMPLE_RATE);
}

function framesForMicroseconds(microseconds: number): number {
  return Math.round((microseconds * PCM_SAMPLE_RATE) / 1_000_000);
}

function assertUnits(units: readonly RecordingDraftUnit[], durationMs: number): void {
  if (units.length > MAX_WINDOW_UNITS) {
    throw new RecordingDraftResourceError("Recording draft has too many units");
  }
  let priorEnd = -1;
  for (const unit of units) {
    if (
      typeof unit.breakAfter !== "boolean" ||
      !Number.isSafeInteger(unit.startMs) ||
      !Number.isSafeInteger(unit.endMs) ||
      unit.startMs < priorEnd ||
      unit.startMs < 0 ||
      unit.endMs <= unit.startMs ||
      unit.endMs > durationMs ||
      unit.text.length < 1 ||
      unit.text.length > MAX_TEXT_LENGTH ||
      unit.text.trim().length === 0
    ) throw new TypeError("Recording draft unit is invalid");
    priorEnd = unit.endMs;
  }
}

function appendToken(current: string, token: string): string {
  if (current === "") return token;
  return /^[A-Za-z0-9]/u.test(token) || /[A-Za-z0-9]$/u.test(current)
    ? `${current} ${token}`
    : `${current}${token}`;
}

function segmentFrom(
  units: readonly RecordingDraftUnit[],
  text: string,
): Omit<RecordingDraftSegment, "seq"> {
  return {
    start_ms: units[0]!.startMs,
    end_ms: units.at(-1)!.endMs,
    speaker_label: null,
    text: text.trim(),
  };
}

function segmentsForUnits(units: readonly RecordingDraftUnit[]): RecordingDraftSegment[] {
  const blocks: Array<Omit<RecordingDraftSegment, "seq">> = [];
  let pending: RecordingDraftUnit[] = [];
  let text = "";
  const flush = () => {
    if (pending.length > 0) blocks.push(segmentFrom(pending, text));
    pending = [];
    text = "";
  };
  for (const unit of units) {
    const candidate = appendToken(text, unit.text);
    if (text !== "" && candidate.length > TARGET_SEGMENT_LENGTH) flush();
    pending.push(unit);
    text = appendToken(text, unit.text);
    if (unit.breakAfter) flush();
  }
  flush();
  if (blocks.length > MAX_SEGMENTS) {
    throw new RecordingDraftResourceError("Recording draft has too many segments");
  }
  return blocks.map((block, seq) => ({ ...block, seq }));
}

function absoluteUnits(
  units: readonly RecordingDraftUnit[],
  offsetMs: number,
): RecordingDraftUnit[] {
  return units.map((unit) => ({
    ...unit,
    startMs: unit.startMs + offsetMs,
    endMs: unit.endMs + offsetMs,
  }));
}

function stitchUnits(
  previous: readonly RecordingDraftUnit[],
  current: readonly RecordingDraftUnit[],
  plan: DraftPlan,
): RecordingDraftUnit[] {
  const offsetMs = millisecondsForFrames(plan.startFrame);
  const incoming = absoluteUnits(current, offsetMs);
  if (plan.reset) return incoming;
  if (incoming.length === 0) return [...previous];
  const seamMs = Math.max(
    offsetMs,
    millisecondsForFrames(plan.boundaryFrame) - OVERLAP_MILLISECONDS / 2,
  );
  const beforeSeam = (unit: RecordingDraftUnit) => (unit.startMs + unit.endMs) / 2 < seamMs;
  return [...previous.filter(beforeSeam), ...incoming.filter((unit) => !beforeSeam(unit))];
}

function sharedPrefixLength(
  previous: readonly RecordingDraftSegment[],
  current: readonly RecordingDraftSegment[],
): number {
  const maximum = Math.min(previous.length, current.length);
  let index = 0;
  while (index < maximum) {
    const left = previous[index]!;
    const right = current[index]!;
    if (left.start_ms !== right.start_ms || left.end_ms !== right.end_ms || left.text !== right.text) {
      break;
    }
    index += 1;
  }
  return index;
}

export class RecordingDraftEngine {
  private readonly now: () => number;
  private originUs: number | undefined;
  private processedThroughFrames = 0;
  private revision = 0;
  private units: readonly RecordingDraftUnit[] = [];
  private segments: readonly RecordingDraftSegment[] = [];

  constructor(private readonly options: RecordingDraftEngineOptions) {
    this.now = options.now ?? Date.now;
  }

  async nextRevision(): Promise<RecordingRevisionMessage | null> {
    const timeline = await this.options.chunks.scan();
    if (timeline === null) return null;
    const plan = this.plan(timeline);
    if (plan === null) return null;
    const samples = await renderRecordingWindow(
      timeline,
      plan.startFrame,
      plan.endFrame,
      (chunk, start, end) => this.options.chunks.read(chunk, start, end),
    );
    const recognized = await this.options.recognize(samples);
    assertUnits(recognized, millisecondsForFrames(plan.endFrame - plan.startFrame));
    const units = stitchUnits(this.units, recognized, plan);
    const segments = segmentsForUnits(units);
    const message = this.message(plan, segments);
    parseRecordingWorkerMessage(message);
    this.accept(timeline, plan, units, segments, message);
    return message;
  }

  private plan(timeline: RecordingTimeline): DraftPlan | null {
    const reset = this.originUs !== undefined && timeline.originUs !== this.originUs;
    const through = reset ? 0 : this.processedThroughFrames;
    if (!reset && timeline.frameCount <= through) return null;
    const priorOrigin = this.originUs ?? timeline.originUs;
    const priorAbsoluteEndUs = priorOrigin + Math.round(
      (this.processedThroughFrames * 1_000_000) / PCM_SAMPLE_RATE,
    );
    const replayThrough = framesForMicroseconds(priorAbsoluteEndUs - timeline.originUs);
    const minimumEnd = reset
      ? Math.max(CADENCE_FRAMES, replayThrough)
      : through + CADENCE_FRAMES;
    if (timeline.frameCount < minimumEnd) return null;
    return {
      boundaryFrame: reset ? 0 : through,
      endFrame: minimumEnd,
      reset,
      startFrame: reset ? 0 : Math.max(0, through - OVERLAP_FRAMES),
    };
  }

  private message(
    plan: DraftPlan,
    segments: readonly RecordingDraftSegment[],
  ): RecordingRevisionMessage {
    const replace = plan.reset ? 0 : sharedPrefixLength(this.segments, segments);
    return {
      type: "revision",
      revision: this.revision + 1,
      base_revision: this.revision,
      replace_from_seq: replace,
      audio_through_ms: millisecondsForFrames(plan.endFrame),
      generated_at_ms: Math.trunc(this.now()),
      segments: segments.slice(replace),
    };
  }

  private accept(
    timeline: RecordingTimeline,
    plan: DraftPlan,
    units: readonly RecordingDraftUnit[],
    segments: readonly RecordingDraftSegment[],
    message: RecordingRevisionMessage,
  ): void {
    this.units = units;
    this.segments = segments;
    this.revision = message.revision;
    this.originUs = timeline.originUs;
    this.processedThroughFrames = plan.endFrame;
  }
}
