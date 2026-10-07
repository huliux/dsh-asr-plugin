import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDshWorkerSpawner } from "../../src/worker/dsh-spawner.js";
import { createWorkerEnvironment } from "../../src/worker/launch.js";
import { createNodeWorkerSpawner } from "../../src/worker/node-spawner.js";
import type { WorkerProcessHandle } from "../../src/worker/process.js";

const originalLeakValue = process.env.UNRELATED_WORKER_TEST;

afterEach(() => {
  if (originalLeakValue === undefined) delete process.env.UNRELATED_WORKER_TEST;
  else process.env.UNRELATED_WORKER_TEST = originalLeakValue;
});

async function streamText(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (stream === undefined) throw new Error("missing stream");
  let text = "";
  for await (const chunk of stream) text += Buffer.from(chunk).toString("utf8");
  return text;
}

describe("Worker spawners", () => {
  it("maps the narrow port onto DSH raw pipes and removes ambient variables", () => {
    process.env.UNRELATED_WORKER_TEST = "must-not-leak";
    let captured: Record<string, unknown> | undefined;
    const handle = {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: vi.fn(),
      waitForExit: vi.fn(async () => true),
    } satisfies WorkerProcessHandle;
    const spawner = createDshWorkerSpawner({
      spawn(spec) {
        captured = spec as unknown as Record<string, unknown>;
        return handle;
      },
    });

    expect(spawner.spawn({
      argv: ["/node", "/worker.js"],
      cwd: "/plugin",
      environment: { LANG: "C.UTF-8" },
      graceMs: 500,
    })).toBe(handle);
    expect(captured).toMatchObject({
      argv: ["/node", "/worker.js"],
      cwd: "/plugin",
      graceMs: 500,
      stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    });
    expect((captured?.env as NodeJS.ProcessEnv).LANG).toBe("C.UTF-8");
    expect((captured?.env as NodeJS.ProcessEnv).UNRELATED_WORKER_TEST).toBeUndefined();
  });

  it("launches without a shell and gives Node an exact environment", async () => {
    process.env.UNRELATED_WORKER_TEST = "must-not-leak";
    const code = [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({ input, env: process.env }));",
      "  process.stderr.write('diagnostic');",
      "});",
    ].join("\n");
    const handle = createNodeWorkerSpawner().spawn({
      argv: [process.execPath, "--input-type=module", "-e", code],
      cwd: process.cwd(),
      environment: { WORKER_TEST_ONLY: "yes" },
      graceMs: 100,
    });
    const stdout = streamText(handle.stdout);
    const stderr = streamText(handle.stderr);
    handle.stdin?.end("ping");

    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null });
    await expect(handle.waitForExit()).resolves.toBe(true);
    const output = JSON.parse(await stdout) as { input: string; env: Record<string, string> };
    expect(output.input).toBe("ping");
    expect(output.env.WORKER_TEST_ONLY).toBe("yes");
    expect(output.env.UNRELATED_WORKER_TEST).toBeUndefined();
    expect(await stderr).toBe("diagnostic");
  });

  it("terminates the standalone child and waits for exit", async () => {
    const handle = createNodeWorkerSpawner().spawn({
      argv: [
        process.execPath,
        "--input-type=module",
        "-e",
        "process.stdout.write('started'); setInterval(() => {}, 1000)",
      ],
      cwd: process.cwd(),
      environment: {},
      graceMs: 50,
    });
    await once(handle.stdout!, "readable").catch(() => undefined);
    handle.terminate();

    const outcome = await handle.done;
    expect(outcome.exitCode === null || outcome.exitCode !== 0).toBe(true);
    await expect(handle.waitForExit()).resolves.toBe(true);
  });

  it("builds only the runtime environment whitelist", () => {
    expect(createWorkerEnvironment({
      PATH: "/bin",
      HOME: "/home/test",
      LANG: "zh_CN.UTF-8",
      MODEL_SECRET_TOKEN: "secret",
      DSH_SESSION_ID: "session",
    })).toEqual({
      PATH: "/bin",
      HOME: "/home/test",
      LANG: "zh_CN.UTF-8",
    });
  });

  it("preserves Electron Node mode through the DSH subprocess environment", () => {
    let environment: NodeJS.ProcessEnv | undefined;
    const handle = { stdin: undefined, stdout: undefined, stderr: undefined,
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate() {}, waitForExit: async () => true } satisfies WorkerProcessHandle;
    const spawner = createDshWorkerSpawner({ spawn(spec) { environment = spec.env; return handle; } });
    spawner.spawn({ argv: ["/desktop", "/worker.js"], cwd: "/plugin", graceMs: 500,
      environment: createWorkerEnvironment({ ELECTRON_RUN_AS_NODE: "1", API_KEY: "must-not-leak" }) });
    expect(environment?.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(environment?.API_KEY).toBeUndefined();
  });
});
