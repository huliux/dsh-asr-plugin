import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { RecordingModelProcess } from "../../src/recording/model-process.js";
import { writeFrame } from "../../src/worker/framing.js";
const fingerprint = "a".repeat(64);
const id = "00000000-0000-4000-8000-000000000001";

it("requires the session cleanup acknowledgement even when the process exits successfully", async () => {
  const stdin = new PassThrough(); stdin.resume();
  const stdout = new PassThrough();
  const model = new RecordingModelProcess({ stdin, stdout, stderr: undefined,
    done: Promise.resolve({ exitCode: 0, signal: null }), terminate: () => {}, waitForExit: async () => true },
    fingerprint, () => {}, () => {});
  await writeFrame(stdout, { type: "model_ready", model_protocol_version: 1, engine_fingerprint: fingerprint });
  await model.ready;
  const session = model.open(id, id); session.stdout!.resume();
  stdout.end();
  await expect(session.done).resolves.toEqual({ exitCode: 1, signal: null });
  await model.dispose();
});

it("rejects unsupported protocol versions before accepting a session", async () => {
  const stdin = new PassThrough(); stdin.resume(); const stdout = new PassThrough();
  const model = new RecordingModelProcess({ stdin, stdout, stderr: undefined,
    done: Promise.resolve({ exitCode: 0, signal: null }), terminate: () => {}, waitForExit: async () => true },
    fingerprint, () => {}, () => {});
  await writeFrame(stdout, { type: "model_ready", model_protocol_version: 2, engine_fingerprint: fingerprint });
  await expect(model.ready).rejects.toThrow();
  await model.dispose();
});
