import type { Readable } from "node:stream";

export const STDERR_TAIL_BYTES = 64 * 1024;

export interface StderrTail {
  readonly text: string;
  readonly truncated: boolean;
}

export async function drainStderrTail(
  stream: Readable,
  maxBytes = STDERR_TAIL_BYTES,
): Promise<StderrTail> {
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  let totalBytes = 0;
  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
      totalBytes += chunk.byteLength;
      chunks.push(chunk);
      retainedBytes += chunk.byteLength;
      while (retainedBytes > maxBytes) {
        const head = chunks[0]!;
        const excess = retainedBytes - maxBytes;
        if (head.byteLength <= excess) {
          chunks.shift();
          retainedBytes -= head.byteLength;
        } else {
          chunks[0] = head.subarray(excess);
          retainedBytes -= excess;
        }
      }
    }
  } catch {
    // Diagnostics must never hide the protocol or process outcome.
  }
  return {
    text: Buffer.concat(chunks, retainedBytes).toString("utf8"),
    truncated: totalBytes > maxBytes,
  };
}
