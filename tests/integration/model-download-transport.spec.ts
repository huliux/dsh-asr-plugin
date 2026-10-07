import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { downloadModelFile } from "../../src/assets/model-download-transport.js";

it("disables curl defaults before any download options", async () => {
  const workRoot = await mkdtemp(join(tmpdir(), "asr-curl-defaults-"));
  const stopped = new Error("Observed subprocess boundary");
  try {
    await writeFile(join(workRoot, ".curlrc"), "invalid-asr-test-option\n");
    await expect(downloadModelFile({ spawn(spec) {
      expect(spec.argv.slice(0, 2)).toEqual(["/usr/bin/curl", "-q"]);
      expect(execFileSync(spec.argv[0]!, [spec.argv[1]!, "--version"], {
        env: { ...process.env, CURL_HOME: workRoot }, encoding: "utf8",
      })).toContain("curl ");
      throw stopped;
    } }, {
      url: "https://modelscope.cn/models/test/resolve/fixed/model.onnx",
      destination: join(workRoot, "model.onnx"), expectedBytes: 1, workRoot,
      signal: new AbortController().signal, progress() {},
    })).rejects.toBe(stopped);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

it("stops reading downloaded model bytes when hash verification is cancelled", async () => {
  const workRoot = await mkdtemp(join(tmpdir(), "asr-download-hash-"));
  const destination = join(workRoot, "model.onnx");
  const bytes = Buffer.alloc(16 * 1024 * 1024, 7);
  const controller = new AbortController();
  const original = fs.createReadStream;
  let readBytes = 0;
  const observed = vi.spyOn(fs, "createReadStream").mockImplementationOnce((path, options) => {
    const stream = original(path, options);
    stream.on("data", chunk => { readBytes += chunk.length; controller.abort(); });
    return stream;
  });
  try {
    await expect(downloadModelFile({ spawn() {
      const done = writeFile(destination, bytes).then(() => ({ exitCode: 0, signal: null }));
      return {
        control: undefined, stdin: undefined, stdout: undefined, stderr: undefined,
        collected: { stdout: { readFrom: () => ({ text: "200", nextOffset: 3, lossy: false }) } },
        done, terminate() {}, waitForExit: async () => true,
      } satisfies SubprocessHandle;
    } }, {
      url: "https://modelscope.cn/models/test/resolve/fixed/model.onnx",
      destination, expectedBytes: bytes.length, workRoot,
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      signal: controller.signal, progress() {},
    })).rejects.toMatchObject({ code: "MODEL_DOWNLOAD_CANCELLED" });
    expect(readBytes).toBeGreaterThan(0);
    expect(readBytes).toBeLessThan(bytes.length);
  } finally {
    observed.mockRestore();
    await rm(workRoot, { recursive: true, force: true });
  }
});
