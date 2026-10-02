import { ModelDownloadError, modelProxyUrl } from "./model-download-contract.js";
import type { ModelDownloadSettings } from "./model-download-contract.js";
import type { SupplyChainAsset } from "./supply-chain.js";

export interface ModelDownloadSource { readonly url: string; readonly proxyUrl?: string }

export function modelDownloadSources(source: SupplyChainAsset, settings: ModelDownloadSettings): ModelDownloadSource[] {
  if (source.distribution !== "public") throw new ModelDownloadError("MODEL_DOWNLOAD_SOURCE_INVALID");
  const urls = source.transports.flatMap(value => "url" in value ? [value.url] : [])
    .filter(url => ["modelscope.cn", "huggingface.co"].includes(new URL(url).hostname));
  const domestic = urls.filter(url => new URL(url).hostname === "modelscope.cn");
  const upstream = urls.filter(url => new URL(url).hostname === "huggingface.co");
  const candidates: ModelDownloadSource[] = [...domestic, ...upstream].map(url => ({ url }));
  if (settings.route === "proxy") {
    for (const url of upstream) {
      if (settings.proxyKind === "mirror") {
        const mirror = new URL(url); mirror.hostname = "hf-mirror.com";
        candidates.push({ url: mirror.href });
      } else candidates.push({ url, proxyUrl: modelProxyUrl(settings.proxyUrl) });
    }
  }
  if (candidates.length === 0) throw new ModelDownloadError("MODEL_DOWNLOAD_SOURCE_INVALID");
  return candidates;
}
