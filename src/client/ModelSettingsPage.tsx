import { ModelDownloadSettings } from "./ModelDownloadSettings.js";
import { RecordingPermissionSettings } from "./RecordingPermissionSettings.js";
import { useCallback, useEffect, useState } from "react";
import {
  Button, CodeBlock, DisclosureRow, IconInfoOutlineRegular, IconRefreshOutlineRegular,
  StateDot,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import type { ModelSettingsStatus } from "../assets/model-settings-contract.js";
import { readModelStatus } from "./model-settings-client.js";
import type { ModelSettingsTranslate } from "./model-settings-locales.js";

import styles from "./ModelSettingsPage.module.css";

type Props = { form: ConfigPageForm | undefined; rpc: ClientConnectionRpc; t: ModelSettingsTranslate };

export function ModelInstructions({ t }: { status: ModelSettingsStatus; t: ModelSettingsTranslate }) {
  const [open, setOpen] = useState(false);
  const target = "--data-dir /path/to/plugin-data";
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
          <CodeBlock code={`dsh plugin --profile web exec dsh-asr-assets ${command.code}`}
            lang="sh" copyLabel={t("copy")} copiedLabel={t("copied")}
            toolbarLabels={{ codeLabel: t("command"), wrapLabel: t("wrap"), unwrapLabel: t("unwrap") }} wrap />
        </div>)}
      </div>
    </DisclosureRow>
  </section>;
}

function ModelDiagnostics({ status, t }: { status: ModelSettingsStatus; t: ModelSettingsTranslate }) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const issues = (["base", "punctuation", "native"] as const)
    .flatMap(key => status[key].issues.map(issue => ({ ...issue, group: key })));
  return <section className={styles.card} aria-label={t("diagnostics")}>
    <DisclosureRow icon={<IconInfoOutlineRegular />} title={t("diagnostics")} open={open} expandable expandOnRowClick
      onToggle={() => setOpen(value => !value)}>
    <p className={styles.description}>{t("diagnosticScope")}</p>
    <div className={styles.diagnosticGroups}>
      {(["base", "punctuation", "native"] as const).map(key => <div key={key} className={styles.diagnosticGroup}>
        <div className={styles.modelTitle}><span className={styles.label}>{t(key)}</span>
          <StateDot state={status[key].state === "ready" ? "done" : key === "punctuation" && status.mode === "base" ? "idle" : "warning"} />
          <span>{t(status[key].state)}</span></div>
        <p className={styles.description}>{t(status[key].state === "ready" ? `${key}Ready` : `${key}Repair`)}</p>
      </div>)}
    </div>
    {issues.length > 0 ? <DisclosureRow icon={<IconInfoOutlineRegular />} title={t("technicalDetails")} open={details} expandable expandOnRowClick
      onToggle={() => setDetails(value => !value)}>
      <ul className={styles.diagnostics}>{issues.map(issue => <li key={`${issue.group}:${issue.id}`}>
        {t(issue.group)} · {issue.id}: {issue.code}</li>)}</ul>
    </DisclosureRow> : null}
    </DisclosureRow>
  </section>;
}

export function ModelSettingsPage({ form, rpc, t }: Props) {
  const [status, setStatus] = useState<ModelSettingsStatus | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void readModelStatus(rpc, controller.signal).then(value => {
      if (!controller.signal.aborted) { setStatus(value); setLoading(false); setError(false); }
    }, () => { if (!controller.signal.aborted) { setStatus(null); setLoading(false); setError(true); } });
    return () => controller.abort();
  }, [rpc, refresh, form?.state.revision]);
  const installed = useCallback(() => setRefresh(value => value + 1), []);
  return <div className={styles.page}>
    <header className={styles.heading}>
      <div><h3 className={styles.title}>{t("assets")}</h3><p className={styles.description}>{t("downloadIntro")}</p></div>
      <Button size="sm" variant="ghost" icon={<IconRefreshOutlineRegular />} onClick={installed}
        disabled={loading}>{t("refresh")}</Button>
    </header>
    {loading ? <p className={styles.loading} role="status"><StateDot state="ongoing" />{t("loading")}</p> : null}
    <ModelDownloadSettings form={form} rpc={rpc} t={t} models={status} onInstalled={installed} />
    <RecordingPermissionSettings rpc={rpc} t={t} />
    {error ? <p className={styles.error} role="status"><StateDot state="error" />{t("failed")}</p> : null}
    {status !== null ? <><ModelDiagnostics status={status} t={t} /><ModelInstructions status={status} t={t} /></> : null}
  </div>;
}
