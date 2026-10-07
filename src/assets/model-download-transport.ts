import { createHash } from "node:crypto";
import fs from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SubprocessHandle, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import { ModelDownloadError } from "./model-download-contract.js";

export interface ModelDownloadTransport {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
}
export interface DownloadFileInput {
  readonly url: string;
  readonly fallbacks?: readonly { url: string; proxyUrl?: string }[];
  readonly expectedSha256?: string;
  readonly destination: string;
  readonly expectedBytes: number;
  readonly proxyUrl?: string;
  readonly workRoot: string;
  readonly signal: AbortSignal;
  readonly progress: (bytes: number) => void;
}
const REDIRECT_HOSTS = ["huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs.hf.co",
  "us.aws.cdn.hf.co", "eu.aws.cdn.hf.co", "cdn-lfs-us-1.hf.co", "cdn-lfs-eu-1.hf.co", "cas-bridge.xethub.hf.co", "modelscope.cn"];

function allowed(url: URL, firstHost: string): boolean {
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  if (firstHost === "huggingface.co" || firstHost === "hf-mirror.com") {
    return url.hostname === "hf-mirror.com" || REDIRECT_HOSTS.slice(0, -1).includes(url.hostname);
  }
  return url.hostname === "modelscope.cn" || url.hostname.endsWith(".modelscope.cn") ||
    url.hostname === "modelscope.oss-cn-beijing.aliyuncs.com" ||
    url.hostname === "modelscope.oss-cn-hangzhou.aliyuncs.com";
}
function configLine(name: string, value: string): string {
  if (/[\r\n\0]/u.test(value)) throw new ModelDownloadError("MODEL_DOWNLOAD_SOURCE_INVALID");
  return `${name} = "${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
function config(input: DownloadFileInput, url: URL, headers: string): string {
  return [configLine("url", url.href), configLine("output", input.destination),
    configLine("dump-header", headers), configLine("proxy", input.proxyUrl ?? ""),
    configLine("noproxy", input.proxyUrl === undefined ? "*" : ""), ""].join("\n");
}
async function progressWhileRunning(handle: SubprocessHandle, input: DownloadFileInput) {
  let finished = false;
  let oversized = false;
  const done = handle.done.finally(() => { finished = true; });
  const watch = (async () => {
    while (!finished) {
      await delay(250);
      if (finished || input.signal.aborted) break;
      const bytes = await stat(input.destination).then(value => value.size, () => 0);
      if (bytes > input.expectedBytes) { oversized = true; handle.terminate(); break; }
      input.progress(bytes);
    }
  })();
  try {
    const outcome = await done;
    await handle.waitForExit();
    if (oversized) throw new ModelDownloadError("MODEL_DOWNLOAD_TOO_LARGE");
    return outcome;
  }
  finally { finished = true; await watch; }
}
async function request(transport: ModelDownloadTransport, input: DownloadFileInput, url: URL) {
  const headers = join(input.workRoot, "response.headers");
  await writeFile(headers, "", { mode: 0o600 });
  await writeFile(input.destination, "", { mode: 0o600 });
  const handle = transport.spawn({
    argv: ["/usr/bin/curl", "-q", "--config", "-", "--silent", "--show-error", "--fail", "--proto", "=https",
      "--connect-timeout", "15", "--max-time", "900", "--speed-limit", "1", "--speed-time", "20", "--max-filesize", String(input.expectedBytes),
      "--write-out", "%{http_code}"], cwd: input.workRoot, graceMs: 2_000, signal: input.signal,
    stdio: { stdin: { data: config(input, url, headers) }, stdout: { maxBytes: 128 }, stderr: { maxBytes: 1_024 } },
    env: { HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined, NO_PROXY: undefined,
      http_proxy: undefined, https_proxy: undefined, all_proxy: undefined, no_proxy: undefined },
  });
  const outcome = await progressWhileRunning(handle, input);
  if (input.signal.aborted) throw new ModelDownloadError("MODEL_DOWNLOAD_CANCELLED");
  if (outcome.exitCode === 63) throw new ModelDownloadError("MODEL_DOWNLOAD_TOO_LARGE");
  if (outcome.exitCode === 23) throw new ModelDownloadError("MODEL_DOWNLOAD_WRITE_FAILED");
  if (outcome.exitCode !== 0) throw new ModelDownloadError("MODEL_DOWNLOAD_FAILED");
  if ((await stat(headers)).size > 65_536) throw new ModelDownloadError("MODEL_DOWNLOAD_HEADERS_INVALID");
  const text = await readFile(headers, "utf8");
  const location = [...text.matchAll(/^location:\s*(.+)\r?$/gim)].at(-1)?.[1]?.trim();
  return { status: Number(handle.collected.stdout?.readFrom(0).text), location };
}
async function downloadCandidateFile(transport: ModelDownloadTransport, input: DownloadFileInput): Promise<void> {
  const first = new URL(input.url);
  if (!["huggingface.co", "hf-mirror.com", "modelscope.cn"].includes(first.hostname)) throw new ModelDownloadError("MODEL_DOWNLOAD_SOURCE_INVALID");
  if (first.hostname !== "huggingface.co" && input.proxyUrl !== undefined) throw new ModelDownloadError("MODEL_DOWNLOAD_SOURCE_INVALID");
  let url = first;
  for (let hop = 0; hop <= 8; hop++) {
    if (!allowed(url, first.hostname)) throw new ModelDownloadError("MODEL_DOWNLOAD_REDIRECT_INVALID");
    const response = await request(transport, input, url);
    if (response.status === 200) {
      const bytes = (await stat(input.destination)).size;
      if (bytes !== input.expectedBytes) throw new ModelDownloadError("MODEL_DOWNLOAD_SIZE_MISMATCH");
      if (input.expectedSha256 !== undefined) {
        const hash = createHash("sha256");
        for await (const chunk of fs.createReadStream(input.destination, { signal: input.signal })) {
          input.signal.throwIfAborted();
          hash.update(chunk);
        }
        if (input.signal.aborted) throw new ModelDownloadError("MODEL_DOWNLOAD_CANCELLED");
        if (hash.digest("hex") !== input.expectedSha256) throw new ModelDownloadError("MODEL_DOWNLOAD_HASH_MISMATCH");
      }
      input.progress(bytes); return;
    }
    if (![301, 302, 303, 307, 308].includes(response.status) || response.location === undefined) break;
    url = new URL(response.location, url);
  }
  throw new ModelDownloadError("MODEL_DOWNLOAD_REDIRECT_INVALID");
}

export async function downloadModelFile(transport: ModelDownloadTransport, input: DownloadFileInput): Promise<void> {
  const candidates = [{ url: input.url, proxyUrl: input.proxyUrl }, ...(input.fallbacks ?? [])];
  for (const [index, candidate] of candidates.entries()) {
    if (input.signal.aborted) throw new ModelDownloadError("MODEL_DOWNLOAD_CANCELLED");
    input.progress(0);
    const request = { ...input, url: candidate.url };
    delete request.proxyUrl;
    if (candidate.proxyUrl !== undefined) request.proxyUrl = candidate.proxyUrl;
    try { await downloadCandidateFile(transport, request); return; }
    catch (error) {
      if (input.signal.aborted) throw new ModelDownloadError("MODEL_DOWNLOAD_CANCELLED");
      if (!(error instanceof ModelDownloadError) || error.code !== "MODEL_DOWNLOAD_FAILED" || index === candidates.length - 1) throw error;
    }
  }
}
