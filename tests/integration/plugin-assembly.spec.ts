import { recordingHttpServer } from "../helpers/recording-http-server.js";
import { readFile, readdir, stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Context } from "@deepseek-ai/cordis";
import { HostConnectionService } from "@deepseek-ai/dsh-client-connection";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import LocalJobRegistry from "@deepseek-ai/dsh-jobs-local";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it } from "vitest";

import * as plugin from "../../src/index.js";
import type { RecordingRpcResult } from "../../src/recording/rpc-contract.js";
import { acquireModelStageLease } from "../../src/assets/runtime-assets-stage-lease.js";
import { acquireDataRootLease } from "../../src/storage/data-root-lease.js";
import { openMeetingRepository } from "../../src/storage/meeting-repository.js";
import { MEETING_TOOL_NAMES } from "../../src/tools/meeting-tools.js";

const roots: string[] = [];
const contexts: Context[] = [];
const LEASE_MEETING_ID = "11111111-1111-4111-8111-111111111111";
const LEASE_RUN_ID = "22222222-2222-4222-8222-222222222222";
const LOADER_MODULES = {
  agents: "@deepseek-ai/dsh-agent",
  jobs: "@deepseek-ai/dsh-jobs-local",
  plugin: "@huliux/dsh-asr-plugin",
  subprocess: "@deepseek-ai/dsh-subprocess-local",
  systemPrompt: "@deepseek-ai/dsh-system-prompt",
  tools: "@deepseek-ai/dsh-tools",
} as const;

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-asr-${label}-`));
  roots.push(root);
  return root;
}

async function hostContext(): Promise<Context> {
  const context = new Context();
  contexts.push(context);
  await context.plugin(AgentRegistry);
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime);
  await context.plugin(LocalJobRegistry);
  await context.plugin(LocalSubprocessRuntime);
  return context;
}

async function loaderContext(
  config: plugin.Config,
  pluginModule: typeof plugin = plugin,
): Promise<{ context: Context; pluginId: string }> {
  const context = new Context();
  contexts.push(context);
  await context.plugin(Loader);
  const modules = new Map<string, unknown>([
    [LOADER_MODULES.agents, AgentRegistry],
    [LOADER_MODULES.systemPrompt, SystemPrompt],
    [LOADER_MODULES.tools, ToolRuntime],
    [LOADER_MODULES.jobs, LocalJobRegistry],
    [LOADER_MODULES.subprocess, LocalSubprocessRuntime],
    [LOADER_MODULES.plugin, pluginModule],
  ]);
  context.loader.internal = {
    version: "v2",
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`);
      return modules.get(specifier);
    },
  } as unknown as NonNullable<typeof context.loader.internal>;
  for (const name of [
    LOADER_MODULES.agents,
    LOADER_MODULES.systemPrompt,
    LOADER_MODULES.tools,
    LOADER_MODULES.jobs,
    LOADER_MODULES.subprocess,
  ]) await context.loader.create({ name });
  const pluginId = await context.loader.create({ name: LOADER_MODULES.plugin, config });
  await context.loader.await();
  return { context, pluginId };
}

async function recordingConnection(context: Context) {
  await context.plugin(ctx => {
    new HostConnectionService(ctx, [], { isAuthenticated: () => true } as never);
  });
  const call = await recordingHttpServer(context);
  const invoke = async (endpoint: string, payload: unknown, signal: AbortSignal) => {
    const response = await call(endpoint, payload, signal);
    if (response.status !== 200) return undefined;
    return (await response.json() as { result: RecordingRpcResult }).result;
  };
  return Object.assign(invoke, { whenIdle: call.whenIdle });
}

function meetingToolNames(context: Context): string[] {
  return context.tools.schemas()
    .map((schema) => schema.name)
    .filter((name) => name.startsWith("meeting_"))
    .sort();
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DSH 插件基础装配", () => {
  it.each(["models/status", "models/prepare"] as const)("forwards cancellation through the assembled %s handler", async endpoint => {
    const context = await hostContext();
    const handler = await recordingConnection(context);
    const root = await temporaryRoot("cancel-model-read");
    await context.plugin(plugin, { data_dir: root });
    const lease = await acquireModelStageLease(root);
    const controller = new AbortController();
    const pending = handler(endpoint, {}, controller.signal);
    try {
      expect(await Promise.race([pending, delay(100, "waiting")])).toBe("waiting");
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(await Promise.race([handler.whenIdle(), delay(500, "still waiting")])).not.toBe("still waiting");
      expect(context.jobs.list()).toEqual([]);
      expect(await handler("state", {}, new AbortController().signal)).toMatchObject({
        ok: true, value: { recording: null, hasRecordingHistory: false },
      });
    } finally {
      await lease[Symbol.asyncDispose]();
      await pending.catch(() => undefined);
    }
  });
  it("defaults downloads to automatic routing while accepting legacy proxy settings", () => {
    expect(plugin.Config({ data_dir: "/isolated" }).hf_download_route.get()).toBe("default");
    expect(plugin.Config({ data_dir: "/isolated", hf_download_route: "proxy" }).hf_download_route.get()).toBe("proxy");
  });
  it("只注入 base 的三个服务并提供数据根与新任务标点配置", () => {
    expect(plugin.Config({ data_dir: "/isolated" }).punctuation_enabled.get()).toBeUndefined();
    expect(plugin.Config({ data_dir: "/isolated", punctuation_enabled: false }).punctuation_enabled.get()).toBe(false);
    expect(plugin.name).toBe("dsh-asr");
    expect(plugin.inject).toEqual(["tools", "jobs", "subprocess"]);
    expect(Object.keys(plugin.Config.dict ?? {}).sort()).toEqual(["data_dir", "hf_download_route", "hf_proxy_kind", "hf_proxy_url", "punctuation_enabled"]);
  });


  it("updates only the new-task punctuation preference without restarting active work", async () => {
    const context = await hostContext();
    const root = await temporaryRoot("hot-punctuation");
    const fiber = await context.plugin(plugin, { data_dir: root, punctuation_enabled: false });
    const repository = openMeetingRepository(join(root, "db/meetings.sqlite3"));
    try {
      repository.createImport({ meetingId: LEASE_MEETING_ID, runId: LEASE_RUN_ID,
        title: "Active task", sourceName: "mode.wav", sourceFormat: "wav",
        sourceSizeBytes: 1024, nowMs: 1_000 });
      await fiber.update({ data_dir: root, punctuation_enabled: true });
      expect(repository.getMeeting(LEASE_MEETING_ID)).toMatchObject({
        status: "processing", activeRunId: LEASE_RUN_ID, errorCode: null,
      });
      expect(fiber.config.punctuation_enabled.get()).toBe(true);
      expect(meetingToolNames(context)).toEqual([...MEETING_TOOL_NAMES].sort());
    } finally { repository.close(); }
  });
  it("加载、热替换和卸载时始终只有八个会议工具", async () => {
    const context = await hostContext();
    const first = await temporaryRoot("first");
    const second = await temporaryRoot("second");
    const fiber = await context.plugin(plugin, {
      data_dir: first,
    });
    const expected = [...MEETING_TOOL_NAMES].sort();
    expect(meetingToolNames(context)).toEqual(expected);
    await expect(stat(join(first, "db", "meetings.sqlite3"))).resolves.toBeDefined();

    fiber.update({ data_dir: second });
    await fiber.await();
    expect(meetingToolNames(context)).toEqual(expected);
    await expect(stat(join(second, "db", "meetings.sqlite3"))).resolves.toBeDefined();

    await fiber.dispose();
    expect(meetingToolNames(context)).toEqual([]);
  });

  it.each(["before", "after"])("连接在插件加载 %s 就绪时提供录音状态与 job 控制面", async (timing) => {
    const web = await hostContext();
    let request: Awaited<ReturnType<typeof recordingConnection>> | undefined;
    if (timing === "before") request = await recordingConnection(web);
    const webRoot = await temporaryRoot("web-job-controller");
    await web.plugin(plugin, { data_dir: webRoot });
    if (timing === "after") request = await recordingConnection(web);
    await expect.poll(() => request?.("state", {}, new AbortController().signal)).toEqual({
      ok: true,
      value: { recording: null, preview: [], hasRecordingHistory: false },
    });

    expect(() => web.jobs.start({
      kind: "meeting",
      label: "Web 录音",
      run: () => ({ cancel: () => undefined, done: Promise.resolve({ status: "completed" }) }),
    })).not.toThrow();

    const headless = await hostContext();
    const headlessRoot = await temporaryRoot("headless-no-controller");
    await headless.plugin(plugin, { data_dir: headlessRoot });
    expect(() => headless.jobs.start({
      kind: "meeting",
      label: "无控制面的录音",
      run: () => ({ cancel: () => undefined, done: Promise.resolve({ status: "completed" }) }),
    })).toThrow("no job controller serves this agent");
  });
});

describe("DSH 插件实例边界", () => {
  it("同一 Host 重复加载会失败且不破坏首个实例", async () => {
    const context = await hostContext();
    const first = await temporaryRoot("primary");
    const second = await temporaryRoot("duplicate");
    const fiber = await context.plugin(plugin, {
      data_dir: first,
    });
    await expect(context.plugin(plugin, {
      data_dir: second,
    })).rejects.toThrow(/meeting_import_transcribe|duplicate|already/i);
    expect(meetingToolNames(context)).toEqual([...MEETING_TOOL_NAMES].sort());
    await fiber.dispose();
  });

  it("第二个 Host 在 reconciliation 和工具注册前被同一数据根拒绝", async () => {
    const root = await temporaryRoot("leased");
    const ownerContext = await hostContext();
    const owner = await ownerContext.plugin(plugin, {
      data_dir: root,
    });
    const repository = openMeetingRepository(join(root, "db", "meetings.sqlite3"));
    repository.createImport({
      meetingId: LEASE_MEETING_ID,
      title: "租约测试",
      sourceName: "lease.wav",
      sourceFormat: "wav",
      sourceSizeBytes: 1_024,
      runId: LEASE_RUN_ID,
      nowMs: 1_000,
    });
    repository.close();

    const contenderContext = await hostContext();
    await expect(contenderContext.plugin(plugin, {
      data_dir: root,
    })).rejects.toMatchObject({ code: "DATA_ROOT_IN_USE" });
    expect(meetingToolNames(contenderContext)).toEqual([]);
    expect(meetingToolNames(ownerContext)).toEqual([...MEETING_TOOL_NAMES].sort());
    const inspection = openMeetingRepository(join(root, "db", "meetings.sqlite3"));
    expect(inspection.getMeeting(LEASE_MEETING_ID)).toMatchObject({
      status: "processing",
      errorCode: null,
    });
    inspection.close();
    await owner.dispose();
  });
});

describe("DSH 插件租约与 Loader", () => {
  it("租约冲突不会创建主数据库或受管工作目录", async () => {
    const root = await temporaryRoot("busy-before-storage");
    const lease = await acquireDataRootLease(root);
    try {
      const contenderContext = await hostContext();
      await expect(contenderContext.plugin(plugin, {
        data_dir: root,
      })).rejects.toMatchObject({ code: "DATA_ROOT_IN_USE" });
      expect(meetingToolNames(contenderContext)).toEqual([]);
      expect(await readdir(root)).toEqual(["host-lease.sqlite3"]);
    } finally {
      await lease[Symbol.asyncDispose]();
    }
  });

  it("真实 Loader 组合热替换插件而不复制 base provider", async () => {
    const first = await temporaryRoot("loader-first");
    const second = await temporaryRoot("loader-second");
    const { context, pluginId } = await loaderContext({
      data_dir: first,
    });
    expect(meetingToolNames(context)).toEqual([...MEETING_TOOL_NAMES].sort());
    const entryNames = [...context.loader.entries()].map((entry) => entry.options.name);
    for (const provider of Object.values(LOADER_MODULES).filter((name) => name !== LOADER_MODULES.plugin)) {
      expect(entryNames.filter((name) => name === provider)).toHaveLength(1);
    }

    await context.loader.update(pluginId, {
      config: { data_dir: second },
    });
    await context.loader.await();
    expect(meetingToolNames(context)).toEqual([...MEETING_TOOL_NAMES].sort());
    await expect(stat(join(second, "db", "meetings.sqlite3"))).resolves.toBeDefined();
  });
});

describe("DSH 插件发布装配", () => {
  it("包只携带一个 Host bundle patch，不重复装配 base provider", async () => {
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      dsh?: {
        bundle?: { patch?: string };
        client?: { inject?: string[]; platform?: string };
      };
      files?: string[];
      exports?: {
        "."?: { default?: string; types?: string };
        "./client"?: { default?: string; types?: string };
        "./package.json"?: string;
      };
      main?: string;
      types?: string;
    };
    expect(manifest).toMatchObject({
      name: "@huliux/dsh-asr-plugin",
      private: true,
      main: "dist/index.js",
      types: "dist/index.d.ts",
      exports: {
        ".": { default: "./dist/index.js", types: "./dist/index.d.ts" },
        "./client": {
          default: "./dist/client.js",
          types: "./dist/client-types/client/index.d.ts",
        },
        "./package.json": "./package.json",
      },
      dsh: {
        bundle: { patch: "./cordis.patch.yml" },
        client: { platform: "web" },
      },
    });
    expect(manifest.files).toContain("cordis.patch.yml");
    const patch = await readFile(resolve("cordis.patch.yml"), "utf8");
    expect(patch).toContain("id: dsh-asr");
    expect(patch).toContain("name: '@huliux/dsh-asr-plugin'");
    expect(patch).not.toMatch(/dsh-(tools|jobs|subprocess-local)/);
  });
});

describe.skipIf(process.env.DSH_RUN_P1A_PLUGIN_BUILT !== "1")("构建产物装配", () => {
  it("从 dist 入口经真实 Loader 注册并卸载七工具", async () => {
    const root = await temporaryRoot("built-loader");
    const specifier = new URL("../../dist/index.js", import.meta.url).href;
    const builtPlugin = await import(specifier) as typeof plugin;
    const { context, pluginId } = await loaderContext({
      data_dir: root,
    }, builtPlugin);
    expect(meetingToolNames(context)).toEqual([...MEETING_TOOL_NAMES].sort());
    await context.loader.remove(pluginId);
    expect(meetingToolNames(context)).toEqual([]);
  });
});
