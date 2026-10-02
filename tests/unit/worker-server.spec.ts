import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { AudioReadError } from "../../src/audio/errors.js";
import { decodeFrames, encodeFrame } from "../../src/worker/framing.js";
import { runWorkerServer } from "../../src/worker/worker-server.js";
import type { AsrResultPayload, AsrRunMessage } from "../../src/worker/types.js";

const fingerprint = "e".repeat(64);

function run(): AsrRunMessage {
  return {
    type: "run",
    request_id: "request-1",
    kind: "asr",
    base_transcript_version: 0,
    payload: { audio_path: "/managed/audio.wav", duration_ms: 1_000 },
  };
}

function resultPayload(): AsrResultPayload {
  return {
    blocks: [{ seq: 0, start_ms: 0, end_ms: 80, text: "hello" }],
    speech_regions: [{ start_ms: 0, end_ms: 100 }],
    empty_reason: null,
    metrics: { vad_ms: 1, asr_ms: 2, max_rss_bytes: 3 },
  };
}

async function collect(stream: PassThrough): Promise<Record<string, unknown>[]> {
  const messages: Record<string, unknown>[] = [];
  for await (const message of decodeFrames(stream)) messages.push(message);
  return messages;
}

function streams() {
  return {
    input: new PassThrough(),
    output: new PassThrough(),
    diagnostics: new PassThrough(),
  };
}

async function text(stream: PassThrough): Promise<string> {
  let output = "";
  for await (const chunk of stream) output += Buffer.from(chunk).toString("utf8");
  return output;
}

describe("one-shot Worker server", () => {
  it("loads before READY, accepts one RUN, and emits a validated RESULT", async () => {
    const io = streams();
    const events: string[] = [];
    const close = vi.fn(async () => { events.push("close"); });
    const execution = runWorkerServer({
      kind: "asr",
      input: io.input,
      output: io.output,
      diagnostics: io.diagnostics,
      async load() {
        events.push("load");
        return {
          engineFingerprint: fingerprint,
          close,
          async execute(_request, report) {
            events.push("execute");
            await report("vad", 0.5);
            return resultPayload();
          },
        };
      },
    });
    io.input.end(encodeFrame(run()));
    const messages = collect(io.output);
    const diagnostics = text(io.diagnostics);

    await expect(execution).resolves.toBe(0);
    expect(await messages).toEqual([
      {
        type: "ready",
        protocol_version: 2,
        kind: "asr",
        engine_fingerprint: fingerprint,
        load_ms: expect.any(Number),
      },
      { type: "progress", request_id: "request-1", stage: "vad", ratio: 0.5 },
      { ...run(), type: "result", payload: resultPayload() },
    ]);
    expect(await diagnostics).toBe("");
    expect(events).toEqual(["load", "execute", "close"]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects a second frame before executing", async () => {
    const io = streams();
    const execute = vi.fn(async () => resultPayload());
    const execution = runWorkerServer({
      kind: "asr",
      ...io,
      input: io.input,
      output: io.output,
      diagnostics: io.diagnostics,
      async load() {
        return { engineFingerprint: fingerprint, execute, async close() {} };
      },
    });
    io.input.end(Buffer.concat([encodeFrame(run()), encodeFrame(run())]));
    const messages = collect(io.output);
    const diagnostics = text(io.diagnostics);

    await expect(execution).resolves.toBe(1);
    expect(await messages).toHaveLength(1);
    expect((await messages)[0]).toMatchObject({ type: "ready" });
    expect(await diagnostics).toContain("INVALID_REQUEST");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects EOF before RUN without fabricating a request id", async () => {
    const io = streams();
    const execution = runWorkerServer({
      kind: "asr",
      input: io.input,
      output: io.output,
      diagnostics: io.diagnostics,
      async load() {
        return { engineFingerprint: fingerprint, async execute() { return resultPayload(); }, async close() {} };
      },
    });
    io.input.end();
    const messages = collect(io.output);

    await expect(execution).resolves.toBe(1);
    expect(await messages).toHaveLength(1);
    expect((await messages)[0]).toMatchObject({ type: "ready" });
  });

  it("emits ERROR(null) when initialization fails", async () => {
    const io = streams();
    const execution = runWorkerServer({
      kind: "asr",
      input: io.input,
      output: io.output,
      diagnostics: io.diagnostics,
      async load() {
        throw Object.assign(new Error("asset path must not leak"), { code: "ASSET_MISSING" });
      },
    });
    io.input.end();
    const messages = collect(io.output);

    await expect(execution).resolves.toBe(1);
    expect(await messages).toEqual([{
      type: "error",
      request_id: null,
      code: "ASSET_MISMATCH",
      stage: "initializing",
      message: "Worker assets failed verification",
    }]);
  });

  it("maps execution failures to one sanitized ERROR and closes runtime first", async () => {
    const io = streams();
    const events: string[] = [];
    const execution = runWorkerServer({
      kind: "asr",
      input: io.input,
      output: io.output,
      diagnostics: io.diagnostics,
      async load() {
        return {
          engineFingerprint: fingerprint,
          async execute() {
            events.push("execute");
            throw Object.assign(new Error("secret transcript"), { code: "MODEL_INFERENCE_FAILED" });
          },
          async close() { events.push("close"); },
        };
      },
    });
    io.input.end(encodeFrame(run()));
    const messages = collect(io.output);

    await expect(execution).resolves.toBe(1);
    expect(await messages).toEqual([
      expect.objectContaining({ type: "ready" }),
      {
        type: "error",
        request_id: "request-1",
        code: "MODEL_INFERENCE_FAILED",
        stage: "asr",
        message: "Model inference failed",
      },
    ]);
    expect(events).toEqual(["execute", "close"]);
  });

  it("保留底层音频读取错误码，不泛化为 INTERNAL_ERROR", async () => {
    const io = streams();
    const execution = runWorkerServer({
      kind: "asr",
      input: io.input,
      output: io.output,
      diagnostics: io.diagnostics,
      async load() {
        return {
          engineFingerprint: fingerprint,
          async execute() {
            throw new AudioReadError("RANGE_INVALID", "private frame range");
          },
          async close() {},
        };
      },
    });
    io.input.end(encodeFrame(run()));
    const messages = collect(io.output);

    await expect(execution).resolves.toBe(1);
    expect(await messages).toEqual([
      expect.objectContaining({ type: "ready" }),
      {
        type: "error",
        request_id: "request-1",
        code: "AUDIO_READ_FAILED",
        stage: "asr",
        message: "Managed audio could not be read",
      },
    ]);
  });

  it("turns an invalid internal result into ERROR before writing a terminal RESULT", async () => {
    const io = streams();
    const execution = runWorkerServer({
      kind: "asr",
      input: io.input,
      output: io.output,
      diagnostics: io.diagnostics,
      async load() {
        return {
          engineFingerprint: fingerprint,
          async execute() {
            return { ...resultPayload(), empty_reason: "silent" } as AsrResultPayload;
          },
          async close() {},
        };
      },
    });
    io.input.end(encodeFrame(run()));
    const messages = collect(io.output);

    await expect(execution).resolves.toBe(1);
    expect(await messages).toEqual([
      expect.objectContaining({ type: "ready" }),
      expect.objectContaining({
        type: "error",
        request_id: "request-1",
        code: "INTERNAL_ERROR",
      }),
    ]);
  });
});
