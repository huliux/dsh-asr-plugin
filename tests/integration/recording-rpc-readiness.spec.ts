import { Context } from "@deepseek-ai/cordis";
import { HostConnectionService } from "@deepseek-ai/dsh-client-connection";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import LocalJobRegistry from "@deepseek-ai/dsh-jobs-local";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as plugin from "../../src/index.js";
import { readModelStatus } from "../../src/client/model-settings-client.js";
import { recordingHttpServer } from "../helpers/recording-http-server.js";

it.each([404, 405])("recovers model reads when hot activation registers routes after HTTP %s", async missing => {
  const context = new Context();
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-rpc-ready-"));
  const observed: number[] = [];
  let activation: PromiseLike<unknown> | undefined;
  try {
    for (const provider of [AgentRegistry, SystemPrompt, ToolRuntime, LocalJobRegistry, LocalSubprocessRuntime]) {
      await context.plugin(provider);
    }
    await context.plugin(ctx => { new HostConnectionService(ctx, [], { isAuthenticated: () => true } as never); });
    const http = await recordingHttpServer(context, missing);
    const rpc = { async call(_channel: string, method: string, payload: unknown, signal?: AbortSignal) {
      const response = await http(method.slice("dsh-asr-recording/".length), payload, signal);
      observed.push(response.status);
      if (!response.ok) {
        activation ??= context.plugin(plugin, { data_dir: root });
        throw new Error(`transport failure for /api/${method}: HTTP ${response.status}`);
      }
      return (await response.json() as { result: unknown }).result;
    } } as ClientConnectionRpc;
    const status = await readModelStatus(rpc, new AbortController().signal);
    expect(status.mode).toBe("base");
    expect(observed[0]).toBe(missing);
    expect(observed.at(-1)).toBe(200);
  } finally {
    await activation;
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
