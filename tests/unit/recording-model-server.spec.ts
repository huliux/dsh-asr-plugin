import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { decodeFrames, writeFrame } from "../../src/worker/framing.js";
import { runRecordingModelServer } from "../../src/recording/model-server.js";


const fingerprint = "a".repeat(64);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("recording model process", () => {
  it("retains models while creating a fresh runtime for each recording", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const diagnostics = new PassThrough(); diagnostics.resume();
    let loads = 0; let closedModels = 0; const sessions: string[] = [];
    const server = runRecordingModelServer({ input, output, diagnostics, load: async () => {
      loads++;
      return { engineFingerprint: fingerprint, close: async () => { closedModels++; },
        createSession: async (meetingId: string) => {
          sessions.push(meetingId);
          return { engineFingerprint: fingerprint,
            runDrafts: async ({signal}: {signal: AbortSignal}) => {
              await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), {once:true}));
            },
            finalize: async () => ({ duration_ms: 1, source_size_bytes: 46, source_sha256: "b".repeat(64),
              result_status: "empty" as const, result_reason: "too_short" as const, segments: [],
              audio_files: ["audio.tmp.wav"],
              metrics: { finalization_ms: 0, max_rss_bytes: 0, cache_hits: 0, cache_misses: 0 } }),
            close: async () => {},
          };
        },
      };
    }});
    const frames = decodeFrames(output)[Symbol.asyncIterator]();
    expect((await frames.next()).value).toEqual({type:"model_ready", model_protocol_version:1, engine_fingerprint:fingerprint});
    for (const n of [1, 2]) {
      const runId = id(n + 10);
      await writeFrame(input, {type:"begin", meeting_id:id(n), run_id:runId});
      expect((await frames.next()).value).toMatchObject({type:"output",run_id:runId,payload:{type:"ready"}});
      await writeFrame(input, {type:"input",run_id:runId,payload:{type:"finalize",request_id:id(n),base_transcript_version:0,capture_end_us:1}});
      await writeFrame(input, {type:"input_end",run_id:runId});
      expect((await frames.next()).value).toMatchObject({type:"output",run_id:runId,payload:{type:"final_result"}});
      expect((await frames.next()).value).toEqual({type:"session_end",run_id:runId,exit_code:0});
      expect(closedModels).toBe(0);
    }
    input.end();
    await expect(server).resolves.toBe(0);
    expect(loads).toBe(1); expect(sessions).toEqual([id(1),id(2)]); expect(closedModels).toBe(1);
  });
});

it.each([
  { type: "begin", meeting_id: "../other", run_id: id(1) },
  { type: "input_end", run_id: id(1) },
  { type: "begin", meeting_id: id(1), run_id: id(2), model_root: "/other" },
])("closes model resources on invalid requests without opening a recording", async message => {
  const input = new PassThrough(); const output = new PassThrough(); output.resume();
  const diagnostics = new PassThrough(); diagnostics.resume();
  let released = false; let sessions = 0;
  const execution = runRecordingModelServer({ input, output, diagnostics, load: async () => ({
    engineFingerprint: fingerprint, createSession: async () => { sessions++; throw new Error("unexpected"); },
    close: async () => { released = true; },
  }) });
  await writeFrame(input, message);
  await expect(execution).resolves.toBe(1);
  expect(sessions).toBe(0);
  expect(released).toBe(true);
});
