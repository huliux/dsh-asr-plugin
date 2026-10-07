import type { Context } from "@deepseek-ai/cordis";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { RecordingWebServer } from "../../src/recording/http-connection.js";

type Route = Parameters<RecordingWebServer["register"]>[0];

export async function recordingHttpServer(context: Context, missingStatus = 404) {
  const routes = new Map<string, Route>();
  const active = new Set<Promise<void>>();
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const route = routes.get(request.url?.split("?", 1)[0] ?? "");
    if (route !== undefined) {
      const pending = route.handler(request, response);
      active.add(pending);
      try { await pending; } finally { active.delete(pending); }
    }
    else { response.writeHead(missingStatus); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("HTTP address missing");
  await context.plugin(ctx => {
    ctx.provide("webServer", { register(route: Route) {
      routes.set(route.path, route);
      return () => { routes.delete(route.path); };
    } });
    ctx.effect(() => async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
  });
  const origin = `http://127.0.0.1:${address.port}`;
  const call = (endpoint: string, payload: unknown = {}, signal?: AbortSignal, options: RequestInit = {}) =>
    fetch(`${origin}/api/dsh-asr-recording/${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "http-test", method: `dsh-asr-recording/${endpoint}`, payload }),
      ...(signal === undefined ? {} : { signal }), ...options,
    });
  return Object.assign(call, { whenIdle: () => Promise.all([...active]) });
}
