export type ModelDownloadPack = "base" | "punctuation";
export type ModelDownloadPhase = "idle" | "downloading" | "verifying" | "installing" | "completed" | "failed" | "cancelled";
export interface ModelDownloadStatus {
  readonly pack: ModelDownloadPack | null;
  readonly phase: ModelDownloadPhase;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly jobId: string | null;
  readonly errorCode: string | null;
}
export interface ModelDownloadSettings {
  readonly route: "default" | "direct" | "proxy";
  readonly proxyUrl?: string;
  readonly proxyKind?: "mirror" | "http";
}
export function customModelProxy(settings: ModelDownloadSettings): string | undefined {
  if (settings.proxyKind === "mirror" || settings.route === "direct" || !settings.proxyUrl?.trim()) return undefined;
  return modelProxyUrl(settings.proxyUrl);
}
export class ModelDownloadError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function modelProxyUrl(value: string | undefined): string {
  try {
    if (value === undefined || value.length > 2_048) throw new Error();
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password ||
      (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error();
    return url.href;
  } catch { throw new ModelDownloadError("MODEL_PROXY_INVALID"); }
}

export interface ModelDownloadControl {
  status(): ModelDownloadStatus;
  start(pack: ModelDownloadPack): Promise<ModelDownloadStatus>;
  cancel(): Promise<ModelDownloadStatus>;
}
