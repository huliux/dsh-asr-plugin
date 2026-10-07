import { clientRequestSchema, type HostConnectionHandle } from "@deepseek-ai/dsh-client-connection";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { RecordingRpcConnection } from "./host-rpc.js";
import { RECORDING_RPC_ENDPOINTS } from "./rpc-contract.js";

type Connection = Pick<HostConnectionHandle, "requestRejection">;
export interface RecordingWebServer {
  register(route: {
    kind: "exact";
    path: string;
    handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  }): () => void;
}
type Handler = Parameters<RecordingRpcConnection["rpc"]["handle"]>[1];
const MAX_BODY_BYTES = 64 * 1024;

function isLoopbackPeer(address: string | undefined): boolean {
  if (address === undefined) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  return normalized === "::1" || (isIP(normalized) === 4 && normalized.startsWith("127."));
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function dispatch(request: IncomingMessage, endpoint: string, handler: Handler, signal: AbortSignal): Promise<Response> {
  if (request.method !== "POST") return new Response("not found", { status: 404 });
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return new Response("invalid content type", { status: 415 });
  }
  const declaredBytes = Number(request.headers["content-length"]);
  if (declaredBytes > MAX_BODY_BYTES) return new Response("request too large", { status: 413 });
  let body: unknown;
  try { body = JSON.parse(await requestBody(request)); }
  catch (error) {
    const status = error instanceof Error && "status" in error && error.status === 413 ? 413 : 400;
    return new Response("invalid request", { status });
  }
  const parsed = clientRequestSchema.safeParse(body);
  if (!parsed.success || parsed.data.method !== `dsh-asr-recording/${endpoint}`) {
    return new Response("invalid request", { status: 400 });
  }
  const result = await handler(endpoint, parsed.data.payload, signal);
  return Response.json({ type: "server-response", rpcId: parsed.data.rpcId, result });
}

async function serve(request: IncomingMessage, response: ServerResponse, connection: Connection, endpoint: string, handler: Handler): Promise<void> {
  const rejection = isLoopbackPeer(request.socket.remoteAddress) ? connection.requestRejection(request) : 403;
  if (rejection !== undefined) {
    response.writeHead(rejection, { connection: "close" }); response.end("request rejected"); return;
  }
  const controller = new AbortController();
  const disconnect = () => { if (!response.writableEnded) controller.abort(); };
  response.on("close", disconnect);
  try {
    const result = await dispatch(request, endpoint, handler, controller.signal);
    if (response.destroyed) return;
    response.writeHead(result.status, { ...Object.fromEntries(result.headers), connection: "close" });
    response.end(await result.text());
  } catch {
    if (!response.destroyed) { response.writeHead(500); response.end("request failed"); }
  } finally { response.off("close", disconnect); }
}

export function recordingHttpConnection(connection: Connection, webServer: RecordingWebServer): RecordingRpcConnection {
  return { rpc: { handle: (_channel, handler) => {
    const removers = RECORDING_RPC_ENDPOINTS.map(endpoint => webServer.register({
      kind: "exact", path: `/api/dsh-asr-recording/${endpoint}`,
      handler: (request, response) => serve(request, response, connection, endpoint, handler),
    }));
    return async () => { for (const remove of removers) remove(); };
  } } };
}
