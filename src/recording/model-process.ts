import { PassThrough } from "node:stream";
import { decodeFrames, writeFrame } from "../worker/framing.js";
import { waitBounded } from "../worker/client-process.js";
import { drainStderrTail } from "../worker/stderr-tail.js";
import type { WorkerProcessHandle, WorkerProcessOutcome } from "../worker/process.js";
import { parseModelWorkerMessage } from "./model-messages.js";

interface SessionChannel {
  readonly runId: string;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly done: Promise<WorkerProcessOutcome>;
  settle(outcome: WorkerProcessOutcome): void;
}

function channel(runId: string): SessionChannel {
  let settle!: (outcome: WorkerProcessOutcome) => void;
  const done = new Promise<WorkerProcessOutcome>(resolve => { settle = resolve; });
  return { runId, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), done, settle };
}

export class RecordingModelProcess {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  private readyReceived = false;
  private active: SessionChannel | undefined;
  private ended = false;

  constructor(private readonly handle: WorkerProcessHandle, private readonly fingerprint: string,
    private readonly onIdle: () => void, private readonly onExit: () => void) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch(() => undefined);
    if (handle.stderr !== undefined) void drainStderrTail(handle.stderr);
    void this.receive().catch(() => undefined).finally(() => { handle.terminate(); return this.exited(); });
  }

  get busy(): boolean { return this.active !== undefined; }

  open(meetingId: string, runId: string): WorkerProcessHandle {
    if (!this.readyReceived || this.ended || this.active !== undefined) throw new Error("Recording models are unavailable");
    const session = channel(runId);
    this.active = session;
    void this.sendInput(session, meetingId).catch(() => this.handle.terminate());
    return { stdin: session.stdin, stdout: session.stdout, stderr: session.stderr, done: session.done,
      terminate: () => this.handle.terminate(),
      waitForExit: async signal => {
        try { await waitBounded(session.done, signal ?? new AbortController().signal,
          performance.now() + 5_000, "termination"); return true; }
        catch { return false; }
      },
    };
  }

  async dispose(): Promise<void> {
    this.handle.terminate();
    const signal = AbortSignal.timeout(5_000);
    if (!await this.handle.waitForExit(signal)) throw new Error("Recording model process did not stop");
  }

  private async sendInput(session: SessionChannel, meetingId: string): Promise<void> {
    const stdin = this.handle.stdin;
    if (stdin === undefined) throw new Error("Recording model input is missing");
    await writeFrame(stdin, { type: "begin", meeting_id: meetingId, run_id: session.runId });
    for await (const payload of decodeFrames(session.stdin)) {
      await writeFrame(stdin, { type: "input", run_id: session.runId, payload });
    }
    await writeFrame(stdin, { type: "input_end", run_id: session.runId });
  }

  private async receive(): Promise<void> {
    if (this.handle.stdout === undefined) throw new Error("Recording model output is missing");
    for await (const raw of decodeFrames(this.handle.stdout)) {
      const message = parseModelWorkerMessage(raw);
      if (message.type === "model_ready") {
        if (this.readyReceived || message.engine_fingerprint !== this.fingerprint) throw new Error("Recording model identity mismatch");
        this.readyReceived = true; this.resolveReady();
      } else {
        const session = this.active;
        if (!this.readyReceived || session === undefined || session.runId !== message.run_id) throw new Error("Recording model session mismatch");
        if (message.type === "output") await writeFrame(session.stdout, message.payload);
        else this.finishSession(session, message.exit_code);
      }
    }
  }

  private finishSession(session: SessionChannel, exitCode: 0 | 1): void {
    this.active = undefined;
    session.stdin.destroy(); session.stdout.end(); session.stderr.end();
    session.settle({ exitCode, signal: null });
    if (exitCode === 0) this.onIdle();
    else this.handle.terminate();
  }

  private async exited(): Promise<void> {
    this.ended = true;
    const outcome = await this.handle.done.catch(() => ({ exitCode: 1, signal: null }));
    this.rejectReady(new Error("Recording model process exited before readiness"));
    const session = this.active;
    this.active = undefined;
    if (session !== undefined) {
      session.stdin.destroy(); session.stdout.end(); session.stderr.end(); session.settle({ exitCode: 1, signal: outcome.signal });
    }
    this.onExit();
  }
}
