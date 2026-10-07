import { PassThrough, type Readable, type Writable } from "node:stream";
import { decodeFrames, writeFrame } from "../worker/framing.js";
import { parseModelHostMessage } from "./model-messages.js";
import { runRecordingWorkerServer, type LoadedRecordingWorkerRuntime } from "./worker-server.js";

export interface LoadedRecordingModels {
  readonly engineFingerprint: string;
  createSession(meetingId: string, runId: string): Promise<LoadedRecordingWorkerRuntime>;
  close(): Promise<void>;
}
interface ModelServerOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly diagnostics: Writable;
  load(): Promise<LoadedRecordingModels>;
}
interface ActiveSession {
  readonly runId: string;
  readonly input: PassThrough;
  readonly done: Promise<void>;
}

function invalid(): never {
  throw new Error("Recording model session is unavailable");
}

class RecordingModelServer {
  private active: ActiveSession | undefined;
  private failed = false;
  constructor(private readonly options: ModelServerOptions, private readonly models: LoadedRecordingModels) {}

  async run(): Promise<0 | 1> {
    await writeFrame(this.options.output, { type: "model_ready", model_protocol_version: 1, engine_fingerprint: this.models.engineFingerprint });
    for await (const raw of decodeFrames(this.options.input)) {
      if (this.failed) invalid();
      const message = parseModelHostMessage(raw);
      if (message.type === "begin") this.begin(message.meeting_id, message.run_id);
      else {
        const session = this.active;
        if (session === undefined || session.runId !== message.run_id || session.input.writableEnded) invalid();
        if (message.type === "input_end") session.input.end();
        else await writeFrame(session.input, message.payload);
      }
    }
    return this.failed || this.active !== undefined ? 1 : 0;
  }

  async close(): Promise<void> {
    this.active?.input.destroy(new Error("Recording model process stopped"));
    await this.active?.done;
  }

  private begin(meetingId: string, runId: string): void {
    if (this.active !== undefined) invalid();
    const input = new PassThrough(); const output = new PassThrough();
    const diagnostics = new PassThrough(); diagnostics.resume();
    const session = { runId, input, done: Promise.resolve() };
    this.active = session;
    session.done = this.execute(session, output, diagnostics, meetingId).catch(() => {
      this.failed = true;
      this.options.input.destroy(new Error("Recording model session failed"));
    });
  }

  private async execute(session: ActiveSession, output: PassThrough, diagnostics: PassThrough, meetingId: string): Promise<void> {
    const execution = runRecordingWorkerServer({ input: session.input, output, diagnostics,
      load: () => this.models.createSession(meetingId, session.runId) });
    const forwarding = (async () => {
      for await (const payload of decodeFrames(output)) {
        await writeFrame(this.options.output, { type: "output", run_id: session.runId, payload });
      }
    })();
    let exitCode: 0 | 1;
    try { [exitCode] = await Promise.all([execution, forwarding]); }
    catch (error) {
      session.input.destroy(new Error("Recording model transport failed"));
      await Promise.allSettled([execution, forwarding]);
      throw error;
    }
    this.active = undefined;
    await writeFrame(this.options.output, { type: "session_end", run_id: session.runId, exit_code: exitCode });
    if (exitCode !== 0) throw new Error("Recording model runtime failed");
  }
}

export async function runRecordingModelServer(options: ModelServerOptions): Promise<0 | 1> {
  let models: LoadedRecordingModels | undefined;
  let server: RecordingModelServer | undefined;
  try {
    models = await options.load();
    server = new RecordingModelServer(options, models);
    return await server.run();
  } catch {
    options.diagnostics.write("RECORDING_MODELS FAILED\n");
    return 1;
  } finally {
    try { await server?.close(); }
    finally {
      try { await models?.close(); }
      finally { options.output.end(); options.diagnostics.end(); }
    }
  }
}
