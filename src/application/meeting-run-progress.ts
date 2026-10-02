import type { WorkerProgressMessage } from "../worker/types.js";

export type MeetingRunStage =
  | "validating"
  | "normalizing"
  | "loading_asr"
  | "transcribing"
  | "loading_diarization"
  | "diarizing"
  | "committing"
  | "cleaning";

export class ProgressOutput {
  private stageValue: MeetingRunStage = "validating";
  private percentValue = 0;
  private terminal = false;
  private unread: string;

  constructor(
    private readonly startedAtMs: number,
    private readonly now: () => number,
  ) {
    this.unread = this.render();
  }

  get stage(): MeetingRunStage {
    return this.stageValue;
  }

  update(stage: MeetingRunStage, percent: number): void {
    if (this.terminal) return;
    this.stageValue = stage;
    this.percentValue = Math.max(this.percentValue, Math.min(100, Math.round(percent)));
    this.unread = this.render();
  }

  finish(stage: MeetingRunStage, errorCode?: string): void {
    if (this.terminal) return;
    this.stageValue = stage;
    if (errorCode === undefined) this.percentValue = 100;
    this.terminal = true;
    this.unread = this.render(errorCode);
  }

  read(): string {
    const value = this.unread;
    this.unread = "";
    return value;
  }

  private render(errorCode?: string): string {
    const elapsedMs = Math.max(0, this.now() - this.startedAtMs);
    return JSON.stringify({
      stage: this.stageValue,
      percent: this.percentValue,
      elapsed_ms: elapsedMs,
      ...(errorCode === undefined ? {} : { error_code: errorCode }),
    });
  }
}

export function workerPercent(
  kind: "asr" | "diarization",
  message: WorkerProgressMessage,
): number {
  const spans = kind === "asr"
    ? { vad: [30, 45], asr: [45, 65] } as const
    : {
      fbank: [70, 75], embed: [75, 82], cluster: [82, 87], assign: [87, 92],
    } as const;
  const span = spans[message.stage as keyof typeof spans];
  if (span === undefined) return kind === "asr" ? 30 : 70;
  return span[0] + (span[1] - span[0]) * message.ratio;
}
