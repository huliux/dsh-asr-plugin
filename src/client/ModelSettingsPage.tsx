import { ModelDownloadSettings } from "./ModelDownloadSettings.js";
import { useCallback, useEffect, useState } from "react";
import {
  Button, CodeBlock, DisclosureRow, IconInfoOutlineRegular, IconRefreshOutlineRegular,
  StateDot, Switch,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import type { ModelSettingsStatus } from "../assets/model-settings-contract.js";
import { readModelStatus, saveModelPreference } from "./model-settings-client.js";
import type { ModelSettingsTranslate } from "./model-settings-locales.js";

import styles from "./ModelSettingsPage.module.css";

type Draft = { enabled: boolean; revision: number };
type Props = { form: ConfigPageForm | undefined; rpc: ClientConnectionRpc; t: ModelSettingsTranslate };

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function ModelInstructions({ status, t }: { status: ModelSettingsStatus; t: ModelSettingsTranslate }) {
  const [open, setOpen] = useState(false);
  const target = `--data-dir ${shellQuote(status.dataDirectory)}`;
  const commands = [
    { label: t("base"), code: `stage /path/to/base.tar ${target}` },
    { label: t("punctuation"), code: `stage /path/to/punctuation.tar ${target}` },
    { label: t("diagnostics"), code: `doctor ${target}` },
  ];
  return <section className={styles.card}>
    <DisclosureRow icon={<IconInfoOutlineRegular />} title={t("instructions")}
      open={open} expandable expandOnRowClick rowClassName={styles.helpHeading} onToggle={() => setOpen(value => !value)}>
      <div className={styles.instructions}>
        <p className={styles.description}>{t("delivery")}</p>
        <p className={styles.description}>{t("stage")}</p>
        {commands.map(command => <div key={command.label} className={styles.command}>
          <span className={styles.label}>{command.label}</span>
          <CodeBlock code={`dsh plugin --profile PROFILE exec dsh-asr-assets ${command.code}`}
            lang="sh" copyLabel={t("copy")} copiedLabel={t("copied")}
            toolbarLabels={{ codeLabel: t("command"), wrapLabel: t("wrap"), unwrapLabel: t("unwrap") }} wrap />
        </div>)}
        <p className={styles.description}>{t("dependencyRepair")}</p>
        <ul className={styles.diagnostics}>{(["base", "punctuation", "native"] as const)
          .flatMap(key => status[key].issues.map(issue => <li key={`${key}:${issue.id}`}>{issue.id}: {issue.code}</li>))}</ul>
      </div>
    </DisclosureRow>
  </section>;
}

export function ModelSettingsPage({ form, rpc, t }: Props) {
  const [status, setStatus] = useState<ModelSettingsStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"failed" | "notReady" | "conflict" | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void readModelStatus(rpc, controller.signal).then(value => {
      if (!controller.signal.aborted) { setStatus(value); setLoading(false); }
    }, () => { if (!controller.signal.aborted) { setStatus(null); setLoading(false); setError("failed"); } });
    return () => controller.abort();
  }, [rpc, refresh, form?.state.revision]);
  const installed = useCallback(() => setRefresh(value => value + 1), []);
  const save = async () => {
    if (draft === null || form === undefined || saving) return;
    setSaving(true); setError(null);
    try {
      const result = await saveModelPreference(rpc, form, draft.enabled, draft.revision);
      if (result === "saved") { setDraft(null); setRefresh(value => value + 1); }
      else setError(result === "not_ready" ? "notReady" : "conflict");
    } catch { setError("failed"); }
    finally { setSaving(false); }
  };
  return <ModelSettingsContent form={form} status={status} draft={draft} saving={saving} loading={loading}
    error={error} t={t} downloads={preference => <ModelDownloadSettings form={form} rpc={rpc} t={t} models={status} onInstalled={installed} preference={preference} />} save={() => { void save(); }} edit={setDraft}
    refresh={() => { setError(null); setRefresh(value => value + 1); }} />;
}

function ModelSettingsContent(props: Omit<Props, "rpc"> & {
  downloads: (preference: React.ReactNode) => React.ReactNode; status: ModelSettingsStatus | null; draft: Draft | null; saving: boolean; loading: boolean;
  error: "failed" | "notReady" | "conflict" | null;
  save: () => void; edit: (draft: Draft | null) => void; refresh: () => void;
}) {
  const { form, status, draft, saving, loading, error, t } = props;
  const writable = form?.state.writable === true && form.state.status === "ready";
  const preference = <>
    {form?.state.status !== "ready" ? <p className={styles.description}>{t("unavailable")}</p> :
      !writable ? <p className={styles.description}>{t("readOnly")}</p> : null}
    <div className={styles.preference}>
      <div><span className={styles.label}>{t("enable")}</span><p className={styles.description}>{t("nextTask")}</p></div>
      <Switch label={t("enable")} checked={draft?.enabled ?? (status?.mode === "enhanced")}
        disabled={!writable || saving || loading || status === null ||
          (!(draft?.enabled ?? (status.mode === "enhanced")) && status.punctuation.state !== "ready")}
        onChange={enabled => { if (form?.state.revision !== undefined) props.edit({ enabled,
          revision: draft?.revision ?? form.state.revision }); }} />
    </div>
    {status !== null && status.punctuation.state !== "ready" ? <p className={styles.notice}>{t("punctuationRequired")}</p> : null}
    {status?.inheritedLegacy ? <p className={styles.description}>{t("legacy")}</p> : null}
    {draft !== null ? <div className={styles.saveRow}><Button size="sm" disabled={!writable || loading || status === null || saving}
      onClick={props.save}>{t(saving ? "saving" : "save")}</Button></div> : null}
  </>;
  return <div className={styles.page}>
    <header className={styles.heading}>
      <div><h3 className={styles.title}>{t("assets")}</h3><p className={styles.description}>{t("downloadIntro")}</p></div>
      <Button size="sm" variant="ghost" icon={<IconRefreshOutlineRegular />} onClick={props.refresh}
        disabled={loading || saving}>{t("refresh")}</Button>
    </header>
    {loading ? <p className={styles.loading} role="status"><StateDot state="ongoing" />{t("loading")}</p> : null}
    {props.downloads(preference)}
    {error !== null ? <p className={styles.error} role="status"><StateDot state="error" />{t(error)}</p> : null}
    {status !== null ? <ModelInstructions status={status} t={t} /> : null}
  </div>;
}
