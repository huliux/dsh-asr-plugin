import { useEffect, useState } from "react";
import { Button, DisclosureRow, IconInfoOutlineRegular, Input, StateDot, Tag } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import type { ModelDownloadStatus } from "../assets/model-download-contract.js";
import type { ModelSettingsStatus } from "../assets/model-settings-contract.js";
import type { ModelSettingsTranslate } from "./model-settings-locales.js";
import { readDownloadStatus, saveDownloadSettings, startModelDownload } from "./model-download-client.js";
import { callRecordingRpc } from "./recording-rpc-transport.js";
import styles from "./ModelSettingsPage.module.css";

type Props = { form: ConfigPageForm | undefined; rpc: ClientConnectionRpc; t: ModelSettingsTranslate;
  models: ModelSettingsStatus | null; onInstalled: () => void };
type Draft = { route: "default"; proxy: string; kind: "http"; revision: number };
const busy = (state: ModelDownloadStatus | null) => state !== null && ["downloading", "verifying", "installing"].includes(state.phase);
const mib = (value: number) => `${(value / 1_048_576).toFixed(1)} MiB`;

function useDownloadPolling(rpc: ClientConnectionRpc, onInstalled: () => void,
  setStatus: (value: ModelDownloadStatus) => void) {
  const [readFailed, setReadFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completed: string | null = null;
    const poll = async () => {
      try {
        const next = await readDownloadStatus(rpc, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(next); setReadFailed(false);
        if (next.phase === "completed" && completed !== next.jobId) { completed = next.jobId; onInstalled(); }
      } catch { if (!controller.signal.aborted) setReadFailed(true); }
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 1_000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [rpc, onInstalled]);
  return readFailed;
}

function useDownloadSettings({ form, rpc, onInstalled }: Props) {
  const [status, setStatus] = useState<ModelDownloadStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"downloadFailed" | "proxyInvalid" | "conflict" | null>(null);
  const value = form?.state.value as Record<string, unknown> | undefined;
  const acceptedProxy = value?.hf_download_route !== "direct" && value?.hf_proxy_kind !== "mirror" &&
    typeof value?.hf_proxy_url === "string" ? value.hf_proxy_url : "";
  const proxy = draft?.proxy ?? acceptedProxy;
  const writable = form?.state.writable === true && form.state.status === "ready";
  const readFailed = useDownloadPolling(rpc, onInstalled, setStatus);
  const edit = (next: Partial<Draft>) => {
    if (form?.state.revision === undefined) return;
    setError(current => current === "proxyInvalid" ? null : current);
    const candidate: Draft = { route: "default", proxy, kind: "http", revision: draft?.revision ?? form.state.revision, ...next };
    setDraft(candidate.proxy.trim() === acceptedProxy.trim() ? null : candidate);
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
  const { acting, act } = useDownloadActions({ rpc, form, draft, setDraft, setStatus, setError });
  const active = busy(status);
  return { status, proxy, writable, draft, saving, acting, error: error ?? (readFailed ? "downloadFailed" : null), active, edit, save, act };
}

function useDownloadActions({ rpc, form, draft, setDraft, setStatus, setError }: Pick<Props, "rpc" | "form"> & {
  draft: Draft | null; setDraft: (value: Draft | null) => void; setStatus: (value: ModelDownloadStatus) => void;
  setError: (value: "downloadFailed" | "proxyInvalid" | "conflict" | null) => void;
}) {
  const [acting, setActing] = useState(false);
  const act = async (action: "start" | "cancel", pack?: "base" | "punctuation") => {
    setActing(true); setError(null);
    try {
      if (action === "start" && pack !== undefined) {
        const result = await startModelDownload(rpc, form, pack, draft, () => setDraft(null));
        if (result !== "started") {
          setError(result === "invalid" ? "proxyInvalid" : result === "conflict" ? "conflict" : "downloadFailed");
          return;
        }
        setDraft(null);
      } else {
        const result = await callRecordingRpc(rpc, "models/download/cancel", {});
        if (!result.ok) setError("downloadFailed");
      }
      setStatus(await readDownloadStatus(rpc));
    } catch { setError("downloadFailed"); }
    finally { setActing(false); }
  };
  return { acting, act };
}

export function ModelDownloadSettings(props: Props) {
  const { form, t, models } = props;
  const state = useDownloadSettings(props);
  const [proxyOpen, setProxyOpen] = useState(false);
  const { writable, status, active, acting, saving, act, error } = state;
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
            disabled={!writable || status === null || active || acting || saving || models === null}
            onClick={() => { void act("start", pack); }}>{t(models?.[pack].state === "invalid" ? "repair" : "download")}</Button> : null}
        </div>
        {status?.pack === pack && (models?.[pack].state !== "ready" || active || status.phase === "completed") ? <DownloadProgress status={status} t={t} cancel={active ?
          <Button size="sm" variant="ghost" disabled={acting} onClick={() => { void act("cancel"); }}>{t("cancelDownload")}</Button> : null}
          recovery={status.phase === "failed" ? <div className={styles.downloadActions}>
            <Button size="sm" variant="outline" disabled={!writable || saving || acting} onClick={() => { void act("start", pack); }}>{t("retry")}</Button>
            {status.errorCode === "MODEL_DOWNLOAD_PROXY_REQUIRED" ? <Button size="sm" variant="ghost"
              onClick={() => setProxyOpen(true)}>{t("configureProxy")}</Button> : null}
          </div> : null} /> : null}
      </div>)}
      <div className={styles.runtimeRow}><span className={styles.description}>{t("native")}</span>
        {models !== null ? <Tag tone={models.native.state === "ready" ? "success" : "danger"}>{t(models.native.state)}</Tag> : null}
      </div>
      {models !== null && !models.selectedReady ? <p className={styles.notice} role="status"><StateDot state="warning" />{t("blocked")}</p> : null}
      {error !== null ? <p className={styles.error} role="status">{t(error)}</p> : null}
    </section>
    <DownloadRoute form={form} t={t} state={state} open={proxyOpen} onToggle={() => setProxyOpen(value => !value)} />
  </>;
}

function DownloadRoute({ form, t, state, open, onToggle }: Pick<Props, "form" | "t"> & {
  state: ReturnType<typeof useDownloadSettings>; open: boolean; onToggle: () => void;
}) {
  const { writable, draft, saving, save, proxy, active, acting, edit, status, act } = state;
  const retry = status?.phase === "failed" && status.errorCode === "MODEL_DOWNLOAD_PROXY_REQUIRED" && status.pack !== null;
  return <section className={styles.card}>
    <DisclosureRow icon={<IconInfoOutlineRegular />} title={`${t("connectionSettings")}${draft !== null ? ` · ${t("unsaved")}` : ""}`} open={open} expandable expandOnRowClick
      onToggle={onToggle} collapsedContent={<span className={styles.connectionSummary}>{t(proxy.trim() ? "configured" : "notConfigured")}</span>}>
      {form?.state.status !== "ready" ? <p className={styles.notice}>{t("unavailable")}</p> :
        !writable ? <p className={styles.notice}>{t("readOnly")}</p> : null}
      <div className={styles.downloadRouting}>
        <label className={styles.downloadRouting}><span>{t("proxyAddress")}</span>
          <Input value={proxy} placeholder="http://127.0.0.1:7890" autoComplete="off" spellCheck={false}
            disabled={!writable || saving || acting || active} onChange={event => edit({ proxy: event.target.value })} />
        </label>
        <p className={styles.description}>{t("proxyHint")}</p>
      </div>
      {draft !== null || retry ? <div className={styles.saveRow}>
        <Button size="sm" disabled={!writable || saving || acting || active} onClick={() => {
          if (retry && status?.pack) void act("start", status.pack); else void save();
        }}>{t(saving || acting ? "saving" : retry ? "saveRetry" : "save")}</Button>
      </div> : null}
    </DisclosureRow>
  </section>;
}

function DownloadProgress({ status, t, cancel, recovery }: { status: ModelDownloadStatus | null; t: ModelSettingsTranslate;
  cancel: React.ReactNode; recovery: React.ReactNode }) {
  const active = busy(status);
  return <>{status !== null && status.phase !== "idle" ? <div className={styles.downloadProgress} role="status">
      <div className={styles.progressHeading}><span><StateDot state={active ? "ongoing" : status.phase === "failed" ? "error" : "idle"} />
        {t(status.phase === "failed" ? "downloadErrorTitle" : status.phase)}</span>{cancel}</div>
      {status.phase === "downloading" ? <>
        <progress aria-label={t("downloading")} value={status.totalBytes > 0 ? status.downloadedBytes : undefined} max={status.totalBytes || 1} />
        <span className={styles.progressBytes}>{mib(status.downloadedBytes)} / {mib(status.totalBytes)}
          {status.totalBytes > 0 ? ` · ${Math.floor(status.downloadedBytes * 100 / status.totalBytes)}%` : ""}</span>
      </> : null}
      {status.phase === "failed" ? <><p className={styles.description}>{t(downloadFailureKey(status.errorCode))}</p>{recovery}</> : null}
      <PreparationSteps status={status} t={t} />
    </div> : null}</>;
}

function downloadFailureKey(code: string | null) {
  if (code === "MODEL_DOWNLOAD_PROXY_REQUIRED") return "proxyRequired";
  if (code === "MODEL_DOWNLOAD_SOURCE_UNAVAILABLE") return "sourceUnavailable";
  if (code === "MODEL_DOWNLOAD_DISK_FULL") return "diskFull";
  if (["MODEL_DOWNLOAD_STORAGE_DENIED", "MODEL_DOWNLOAD_WRITE_FAILED", "ASSET_PATH_INVALID"].includes(code ?? "")) return "storageFailed";
  if (["MODEL_DOWNLOAD_HASH_MISMATCH", "MODEL_DOWNLOAD_SIZE_MISMATCH", "MODEL_DOWNLOAD_TOO_LARGE",
    "ASSET_HASH_MISMATCH", "ASSET_SIZE_MISMATCH"].includes(code ?? "")) return "verificationFailed";
  return "downloadFailed";
}

function PreparationSteps({ status, t }: { status: ModelDownloadStatus; t: ModelSettingsTranslate }) {
  const phases = ["downloading", "verifying", "installing"] as const;
  const index = status.phase === "completed" ? phases.length : phases.findIndex(phase => phase === status.phase);
  if (index < 0) return null;
  return <ol className={styles.preparationSteps} aria-label={t("preparationSteps")}>
    {phases.map((phase, step) => <li key={phase}>
      <StateDot appearance="step" size={16} state={step < index ? "done" : step === index ? "ongoing" : "idle"} />
      <span>{t(phase === "downloading" ? "prepareDownload" : phase === "verifying" ? "prepareVerify" : "prepareInstall")}</span>
    </li>)}
  </ol>;
}
