import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { HostConnectionService } from "@deepseek-ai/dsh-client-connection";
import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { recordingHttpConnection } from "../../src/recording/http-connection.js";

type Route = { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> };

const lan = Object.entries(networkInterfaces()).filter(([name]) => name.startsWith("en"))
  .flatMap(([, rows]) => rows ?? []).find(row => row.family === "IPv4" && !row.internal);

it.skipIf(lan === undefined)("rejects a non-loopback peer even with an authenticated forged localhost Host", async () => {
  const context = new Context();
  const connection = new HostConnectionService(context, [], { isAuthenticated: () => true } as never);
  const shared = connection.createSharedFetchHandler("/api");
  const routes = new Map<string, Route>();
  const handler = vi.fn(async () => ({ ok: true as const, value: null }));
  const dispose = recordingHttpConnection(connection, {
    register: (route: Route) => { routes.set(route.path, route); return () => { routes.delete(route.path); }; },
  }).rpc.handle("/dsh-asr-recording", handler, { authority: "loopback" });
  const server = createServer(async (req, res) => {
    const route = routes.get(req.url!);
    if (route !== undefined) return route.handler(req, res);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await shared.fetch(new Request(`http://dsh.internal${req.url}`, {
      method: req.method ?? "POST", headers: { host: req.headers.host!, "content-type": "application/json" },
      body: Buffer.concat(chunks),
    }));
    res.writeHead(response.status); res.end(await response.text());
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No TCP address");
    const call = (localAddress?: string) => new Promise<number>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", localAddress, port: address.port, path: "/api/dsh-asr-recording/state", method: "POST",
        headers: { host: `127.0.0.1:${address.port}`, "content-type": "application/json" } }, res => {
        res.resume(); res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ type: "client-request", rpcId: "peer-check", method: "dsh-asr-recording/state", payload: {} }));
    });
    expect(await call()).toBe(200);
    if (lan === undefined) throw new Error("Non-loopback interface required for peer regression");
    expect(await call(lan.address)).toBe(403);
    expect(handler).toHaveBeenCalledTimes(1);
  } finally {
    await dispose(); await context.fiber.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
