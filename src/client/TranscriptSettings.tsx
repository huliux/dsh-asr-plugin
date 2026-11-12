import { useState } from "react";
import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import { callRecordingRpc } from "./recording-rpc-transport.js";
import type { ModelSettingsTranslate } from "./model-settings-locales.js";
import styles from "./ModelSettingsPage.module.css";

interface Props {
  readonly form: ConfigPageForm | undefined;
  readonly rpc: ClientConnectionRpc;
  readonly t: ModelSettingsTranslate;
}

function transcriptDirectory(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const field = (value as Record<string, unknown>).transcript_directory;
  return typeof field === "string" ? field : "";
}

/**
 * Default folder for exported transcripts. The macOS chooser runs on the host,
 * so the same dialog is available from the recording panel when no folder is
 * configured yet.
 */
export function TranscriptSettings({ form, rpc, t }: Props) {
  const accepted = transcriptDirectory(form?.state.value);
  const [draft, setDraft] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [failed, setFailed] = useState(false);
  const writable = form?.state.writable === true && form.state.status === "ready";
  const value = draft ?? accepted;

  const choose = async (): Promise<void> => {
    setPicking(true);
    setFailed(false);
    try {
      const result = await callRecordingRpc(rpc, "transcripts/choose-directory", {});
      if (result.ok && typeof result.value === "string") setDraft(result.value);
      else if (!result.ok && result.error.message !== "CANCELLED_BY_USER") setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setPicking(false);
    }
  };

  const save = async (): Promise<void> => {
    if (form?.state.revision === undefined) return;
    const next = value.trim();
    if (next !== "" && !next.startsWith("/")) {
      setFailed(true);
      return;
    }
    setFailed(false);
    try {
      const saved = await form.mutate([{ op: "set", path: ["transcript_directory"], value: next }], form.state.revision);
      if (saved) setDraft(null);
      else setFailed(true);
    } catch {
      setFailed(true);
    }
  };

  return <section className={styles.card}>
    <div className={styles.heading}>
      <div>
        <h4 className={styles.title}>{t("transcripts")}</h4>
        <p className={styles.description}>{t("transcriptFolderHint")}</p>
      </div>
    </div>
    <div className={styles.downloadRouting}>
      <label><span className={styles.label}>{t("transcriptFolder")}</span>
        <Input value={value} placeholder={t("transcriptFolderUnset")} autoComplete="off" spellCheck={false}
          disabled={!writable || picking} onChange={event => setDraft(event.target.value)} />
      </label>
    </div>
    <div className={styles.downloadActions}>
      <Button size="sm" variant="outline" disabled={!writable || picking} onClick={() => { void choose(); }}>
        {t("chooseFolder")}
      </Button>
      <Button size="sm" disabled={!writable || picking || value.trim() === accepted.trim()}
        onClick={() => { void save(); }}>{t("save")}</Button>
    </div>
    {failed ? <p className={styles.error} role="status">{t("transcriptFolderInvalid")}</p> : null}
  </section>;
}
