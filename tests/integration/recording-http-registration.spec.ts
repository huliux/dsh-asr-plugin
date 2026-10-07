import { recordingHttpServer } from "../helpers/recording-http-server.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { HostConnectionService } from "@deepseek-ai/dsh-client-connection";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import LocalJobRegistry from "@deepseek-ai/dsh-jobs-local";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { expect, it, vi } from "vitest";
import * as plugin from "../../src/index.js";

it("registers recording endpoints after the shared connection is already active", async () => {
  const context = new Context();
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-http-"));
  try {
    for (const provider of [AgentRegistry, SystemPrompt, ToolRuntime, LocalJobRegistry, LocalSubprocessRuntime]) {
      await context.plugin(provider);
    }
    await context.plugin(ctx => {
      new HostConnectionService(ctx, [], { isAuthenticated: () => true } as never);
    });
    const call = await recordingHttpServer(context);
    const fiber = await context.plugin(plugin, { data_dir: root });
    const read = async () => {
      const response = await call("state");
      return { status: response.status, body: await response.text() };
    };
    await expect.poll(read).toMatchObject({ status: 200 });
    expect(JSON.parse((await read()).body).result.value.recording).toBeNull();
    expect((await call("state", {}, undefined, { headers: {
      origin: "https://example.com", "content-type": "application/json",
    } })).status).toBe(403);
    expect((await call("state", {}, undefined, { body: JSON.stringify({
      type: "client-request", rpcId: "registration", method: "control", payload: {},
    }) })).status).toBe(400);
    expect((await call("state", {}, undefined, { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await call("state", {}, undefined, { body: "not json" })).status).toBe(400);
    expect((await call("state", {}, undefined, { body: "x".repeat(65537) })).status).toBe(413);
    await fiber.dispose();
    expect((await read()).status).toBe(404);
    const reactivated = await context.plugin(plugin, { data_dir: root });
    await expect.poll(read).toMatchObject({ status: 200 });
    await reactivated.dispose();
    expect((await read()).status).toBe(404);
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});


it.each([false, true])("refreshes host settings without coupling failures to activation (throws=%s)", async (throws) => {
  const context = new Context();
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-settings-ready-"));
  let activePlugin: typeof context.fiber | undefined;
  const observed: number[] = [];
  const describe = vi.fn(() => {
    observed.push(activePlugin?.state ?? -1);
    if (throws) throw new Error("unrelated settings listener failed");
    return [];
  });
  try {
    await context.plugin(ctx => { ctx.provide("settings", { describe } as never); });
    for (const provider of [AgentRegistry, SystemPrompt, ToolRuntime, LocalJobRegistry, LocalSubprocessRuntime]) {
      await context.plugin(provider);
    }
    await context.plugin(ctx => {
      new HostConnectionService(ctx, [], { isAuthenticated: () => true } as never);
    });
    const installed = context.plugin(plugin, { data_dir: root });
    activePlugin = installed;
    await installed;
    await expect.poll(() => describe.mock.calls.length).toBe(1);
    expect(observed).toEqual([2]);
    expect(installed.state).toBe(2);
    await installed.dispose();
    expect(describe).toHaveBeenCalledTimes(1);
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
