import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  FrameProtocolError,
  MAX_FRAME_PAYLOAD_BYTES,
  decodeFrames,
  encodeFrame,
  writeFrame,
} from "../../src/worker/framing.js";

async function collectFrames(chunks: readonly Buffer[]): Promise<unknown[]> {
  const stream = PassThrough.from(chunks);
  const frames: unknown[] = [];
  for await (const frame of decodeFrames(stream)) frames.push(frame);
  return frames;
}

function prefix(length: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(length);
  return result;
}

describe("Worker frame codec", () => {
  it("decodes a frame split at every byte", async () => {
    const encoded = encodeFrame({ answer: "你好" });
    const chunks = [...encoded].map((byte) => Buffer.from([byte]));

    await expect(collectFrames(chunks)).resolves.toEqual([{ answer: "你好" }]);
  });

  it("decodes multiple frames from one stream chunk", async () => {
    const chunk = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })]);

    await expect(collectFrames([chunk])).resolves.toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("waits for drain when the writable applies backpressure", async () => {
    const writes: Buffer[] = [];
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        writes.push(Buffer.from(chunk));
        setImmediate(callback);
      },
    });

    await expect(writeFrame(stream, { ok: true })).resolves.toBeGreaterThan(0);
    expect(await collectFrames(writes)).toEqual([{ ok: true }]);
  });

  it("rejects invalid UTF-8", async () => {
    await expect(collectFrames([prefix(2), Buffer.from([0xc3, 0x28])]))
      .rejects.toMatchObject({ code: "INVALID_UTF8" });
  });

  it.each([
    ["partial prefix", Buffer.from([0, 0])],
    ["partial payload", Buffer.concat([prefix(4), Buffer.from("{}")])],
  ])("rejects EOF with a %s", async (_label, chunk) => {
    await expect(collectFrames([chunk])).rejects.toMatchObject({ code: "TRUNCATED_FRAME" });
  });

  it("rejects zero-length and oversized frame prefixes before reading payload", async () => {
    await expect(collectFrames([prefix(0)])).rejects.toMatchObject({ code: "INVALID_FRAME_LENGTH" });
    await expect(collectFrames([prefix(MAX_FRAME_PAYLOAD_BYTES + 1)]))
      .rejects.toMatchObject({ code: "INVALID_FRAME_LENGTH" });
  });

  it("round-trips an exact 32 MiB payload and rejects 32 MiB + 1", async () => {
    const jsonOverhead = Buffer.byteLength(JSON.stringify({ value: "" }));
    const exact = { value: "x".repeat(MAX_FRAME_PAYLOAD_BYTES - jsonOverhead) };
    const oversized = { value: `${exact.value}x` };

    const encoded = encodeFrame(exact);
    expect(encoded.readUInt32BE(0)).toBe(MAX_FRAME_PAYLOAD_BYTES);
    const [decoded] = await collectFrames([encoded]);
    expect(decoded).toEqual(exact);
    expect(() => encodeFrame(oversized)).toThrow(FrameProtocolError);
  });

  it("rejects malformed JSON and non-object roots", async () => {
    await expect(collectFrames([Buffer.concat([prefix(1), Buffer.from("{")])]))
      .rejects.toMatchObject({ code: "INVALID_JSON" });
    await expect(collectFrames([Buffer.concat([prefix(4), Buffer.from("null")])]))
      .rejects.toMatchObject({ code: "INVALID_JSON_ROOT" });
  });
});
