import { useEffect, useState } from "react";
import { Button, DisclosureRow, IconInfoOutlineRegular, Input, StateDot, Tag } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import type { ModelDownloadStatus } from "../assets/model-download-contract.js";
import type { ModelSettingsStatus } from "../assets/model-settings-contract.js";
import type { ModelSettingsTranslate } from "./model-settings-locales.js";
import { readDownloadStatus, saveDownloadSettings } from "./model-download-client.js";
import { RECORDING_RPC_CHANNEL } from "../recording/rpc-contract.js";
import styles from "./ModelSettingsPage.module.css";

type Props = { form: ConfigPageForm | undefined; rpc: ClientConnectionRpc; t: ModelSettingsTranslate;
  models: ModelSettingsStatus | null; onInstalled: () => void; preference: React.ReactNode };
type Draft = { route: "direct" | "proxy"; proxy: string; kind: "mirror" | "http"; revision: number };
const busy = (state: ModelDownloadStatus | null) => state !== null && ["downloading", "verifying", "installing"].includes(state.phase);
const mib = (value: number) => `${(value / 1_048_576).toFixed(1)} MiB`;

function useDownloadPolling(rpc: ClientConnectionRpc, onInstalled: () => void,
  setStatus: (value: ModelDownloadStatus) => void,
  setError: (value: "downloadFailed") => void) {
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completed: string | null = null;
    const poll = async () => {
      try {
        const next = await readDownloadStatus(rpc, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(next);
        if (next.phase === "completed" && completed !== next.jobId) { completed = next.jobId; onInstalled(); }
      } catch { if (!controller.signal.aborted) setError("downloadFailed"); }
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 1_000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [rpc, onInstalled]);
}

function useDownloadSettings({ form, rpc, onInstalled }: Props) {
  const [status, setStatus] = useState<ModelDownloadStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<"downloadFailed" | "proxyInvalid" | "conflict" | null>(null);
  const value = form?.state.value as Record<string, unknown> | undefined;
  const acceptedRoute = value?.hf_download_route === "direct" ? "direct" : "proxy";
  const acceptedProxy = typeof value?.hf_proxy_url === "string" ? value.hf_proxy_url : "";
  const acceptedKind = value?.hf_proxy_kind === "http" ||
    (value?.hf_proxy_kind === undefined && acceptedProxy.trim() !== "") ? "http" : "mirror";
  const route = draft?.route ?? acceptedRoute, proxy = draft?.proxy ?? acceptedProxy, kind = draft?.kind ?? acceptedKind;
  const writable = form?.state.writable === true && form.state.status === "ready";
  useDownloadPolling(rpc, onInstalled, setStatus, setError);
  const edit = (next: Partial<Draft>) => {
    if (form?.state.revision === undefined) return;
    const candidate = { route, proxy, kind, revision: draft?.revision ?? form.state.revision, ...next };
    setDraft(candidate.route === acceptedRoute && candidate.proxy.trim() === acceptedProxy.trim() &&
      candidate.kind === acceptedKind ? null : candidate);
  };
  const save = async () => {
    if (draft === null || form === undefined) return;
    setSaving(true); setError(null);
    try {
      const result = await saveDownloadSettings(form, draft.route, draft.proxy, draft.revision, draft.kind);
      if (result === "saved") setDraft(null);
      else setError(result === "invalid" ? "proxyInvalid" : "conflict");
    } catch { setError("conflict"); }
    finally { setSaving(false); }
  };
  const act = async (action: "start" | "cancel", pack?: "base" | "punctuation") => {
    setActing(true); setError(null);
    try {
      const result = await rpc.call(RECORDING_RPC_CHANNEL, `models/download/${action}`, pack === undefined ? {} : { pack });
      if (!result.ok) setError(result.error.message === "MODEL_PROXY_INVALID" ? "proxyInvalid" : "downloadFailed");
      setStatus(await readDownloadStatus(rpc));
    } catch { setError("downloadFailed"); }
    finally { setActing(false); }
  };
  const active = busy(status);
  return { status, route, proxy, kind, writable, draft, saving, acting, error, active, edit, save, act };
}

export function ModelDownloadSettings(props: Props) {
  const { form, t, models } = props;
  const state = useDownloadSettings(props);
  const { writable, status, active, acting, saving, draft, act, error } = state;
  return <>
    <section className={styles.card} aria-label={t("assets")}>
      {(["base", "punctuation"] as const).map(pack => <div key={pack} className={styles.modelBlock}>
        <div className={styles.modelRow}>
          <div className={styles.modelCopy}><div className={styles.modelTitle}>
            <span className={styles.label}>{t(pack)}</span>
            {models !== null ? <Tag tone={models[pack].state === "ready" ? "success" : models[pack].state === "invalid" ? "danger" : "neutral"}>
              {t(models[pack].state)}</Tag> : null}
          </div><p className={styles.description}>{t(`${pack}Description`)} · {t(pack === "base" ? "baseSize" : "punctuationSize")}</p></div>
          {models?.[pack].state !== "ready" ? <Button size="sm"
            variant={pack === "base" ? "primary" : "outline"} aria-label={t(pack === "base" ? "downloadBase" : "downloadPunctuation")}
            disabled={!writable || status === null || active || acting || saving || draft !== null || models === null}
            onClick={() => { void act("start", pack); }}>{t(models?.[pack].state === "invalid" ? "repair" : "download")}</Button> : null}
        </div>
        {status?.pack === pack && (models?.[pack].state !== "ready" || active || status.phase === "completed") ? <DownloadProgress status={status} t={t} cancel={active ?
          <Button size="sm" variant="ghost" disabled={acting} onClick={() => { void act("cancel"); }}>{t("cancelDownload")}</Button> : null} /> : null}
        {pack === "punctuation" ? <div className={styles.modelPreference}>{props.preference}</div> : null}
      </div>)}
      <div className={styles.runtimeRow}><span className={styles.description}>{t("native")}</span>
        {models !== null ? <Tag tone={models.native.state === "ready" ? "success" : "danger"}>{t(models.native.state)}</Tag> : null}
      </div>
      {models !== null && !models.selectedReady ? <p className={styles.notice} role="status"><StateDot state="warning" />{t("blocked")}</p> : null}
      {draft !== null ? <p className={styles.notice} role="status">{t("downloadSettingsPending")}</p> : null}
      {error !== null ? <p className={styles.error} role="status">{t(error)}</p> : null}
    </section>
    <DownloadRoute form={form} t={t} state={state} />
  </>;
}

function DownloadRoute({ form, t, state }: Pick<Props, "form" | "t"> & { state: ReturnType<typeof useDownloadSettings> }) {
  const { writable, draft, saving, save, route, active, edit } = state;
  const [open, setOpen] = useState(false);
  return <section className={styles.card}>
    <DisclosureRow icon={<IconInfoOutlineRegular />} title={`${t("connectionSettings")}${draft !== null ? ` · ${t("unsaved")}` : ""}`} open={open} expandable expandOnRowClick
      onToggle={() => setOpen(value => !value)} collapsedContent={<span className={styles.connectionSummary}>{t(route)}</span>}>
      {form?.state.status !== "ready" ? <p className={styles.notice}>{t("unavailable")}</p> :
        !writable ? <p className={styles.notice}>{t("readOnly")}</p> : null}
      <div className={styles.downloadRouting}>
        <span className={styles.label}>{t("hfRoute")}</span>
        <div className={styles.downloadActions}>
          {(["direct", "proxy"] as const).map(item => <Button key={item} size="sm"
            variant={route === item ? "primary" : "outline"} aria-pressed={route === item}
            disabled={!writable || saving || active} onClick={() => edit({ route: item, ...(item === "proxy" ? { kind: "mirror" as const } : {}) })}>{t(item)}</Button>)}
        </div>
        {route === "proxy" ? <ProxyOptions t={t} state={state} /> : null}
        <p className={styles.description}>{t("fallbackHint")}</p>
      </div>
      {draft !== null ? <div className={styles.saveRow}>
        <Button size="sm" disabled={!writable || saving || active} onClick={() => { void save(); }}>{t(saving ? "saving" : "saveRoute")}</Button>
        <span className={styles.description} role="status">{t("saveBeforeDownload")}</span>
      </div> : null}
    </DisclosureRow>
  </section>;
}

function ProxyOptions({ t, state }: Pick<Props, "t"> & { state: ReturnType<typeof useDownloadSettings> }) {
  const { kind, proxy, writable, saving, active, edit } = state;
  const disabled = !writable || saving || active;
  return <div className={styles.proxyOptions}>
    <div className={styles.downloadActions}>
      {(["mirror", "http"] as const).map(value => <Button key={value} size="sm" variant={kind === value ? "outline" : "ghost"}
        aria-pressed={kind === value} disabled={disabled} onClick={() => edit({ kind: value })}>
        {t(value === "mirror" ? "defaultMirror" : "customProxy")}</Button>)}
    </div>
    {kind === "mirror" ? <a className={styles.description} href="https://hf-mirror.com/" target="_blank" rel="noreferrer">hf-mirror.com</a> :
      <label className={styles.downloadRouting}><span>{t("proxyAddress")}</span>
        <Input value={proxy} placeholder="http://127.0.0.1:7890" autoComplete="off" spellCheck={false}
          disabled={disabled} onChange={event => edit({ proxy: event.target.value })} />
      </label>}
  </div>;
}

function DownloadProgress({ status, t, cancel }: { status: ModelDownloadStatus | null; t: ModelSettingsTranslate; cancel: React.ReactNode }) {
  const active = busy(status);
  return <>{status !== null && status.phase !== "idle" ? <div className={styles.downloadProgress} role="status">
      <div className={styles.progressHeading}><span><StateDot state={active ? "ongoing" : status.phase === "failed" ? "error" : "idle"} />
        {t(status.phase === "failed" ? "downloadErrorTitle" : status.phase)}</span>{cancel}</div>
      {status.phase === "downloading" ? <>
        <progress aria-label={t("downloading")} value={status.totalBytes > 0 ? status.downloadedBytes : undefined} max={status.totalBytes || 1} />
        <span className={styles.progressBytes}>{mib(status.downloadedBytes)} / {mib(status.totalBytes)}
          {status.totalBytes > 0 ? ` · ${Math.floor(status.downloadedBytes * 100 / status.totalBytes)}%` : ""}</span>
      </> : null}
      {status.phase === "failed" ? <p className={styles.description}>{t("downloadFailed")}</p> : null}
    </div> : null}</>;
}
