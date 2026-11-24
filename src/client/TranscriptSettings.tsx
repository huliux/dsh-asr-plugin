import { useState } from "react";
import { Button, Input, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import { callRecordingRpc } from "./recording-rpc-transport.js";
import type { ModelSettingsTranslate } from "./model-settings-locales.js";
import styles from "./ModelSettingsPage.module.css";

interface Props {
  readonly form: ConfigPageForm | undefined;
  readonly rpc: ClientConnectionRpc;
  readonly t: ModelSettingsTranslate;
  /** Host-supplied binding; omitted, the section reads the plugin Config keys. */
  readonly okf?: OkfSettingsBinding;
}

export interface OkfSettingsValues {
  readonly directory: string;
  readonly autoIngest: boolean;
}

/**
 * Persistence surface for the Open knowledge base section. A host that keeps
 * these settings outside the `dsh-asr` Config schema passes its own binding
 * instead of relying on the default `okf_directory` / `okf_auto_ingest` keys.
 */
export interface OkfSettingsBinding {
  readonly directory: string;
  readonly autoIngest: boolean;
  readonly writable: boolean;
  chooseDirectory(): Promise<string | null>;
  save(next: OkfSettingsValues): Promise<boolean>;
}

function transcriptDirectory(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const field = (value as Record<string, unknown>).transcript_directory;
  return typeof field === "string" ? field : "";
}

function okfAccepted(value: unknown): OkfSettingsValues {
  if (typeof value !== "object" || value === null) return { directory: "", autoIngest: true };
  const fields = value as Record<string, unknown>;
  const directory = fields.okf_directory;
  const autoIngest = fields.okf_auto_ingest;
  return {
    directory: typeof directory === "string" ? directory : "",
    autoIngest: typeof autoIngest === "boolean" ? autoIngest : true,
  };
}

function OkfSettingsSection({ binding, t }: { readonly binding: OkfSettingsBinding; readonly t: ModelSettingsTranslate }) {
  const accepted: OkfSettingsValues = { directory: binding.directory, autoIngest: binding.autoIngest };
  const [draft, setDraft] = useState<OkfSettingsValues | null>(null);
  const [picking, setPicking] = useState(false);
  const [failure, setFailure] = useState<"invalid" | "save" | null>(null);
  const value = draft ?? accepted;
  const writable = binding.writable;
  const unchanged = value.directory.trim() === accepted.directory.trim() && value.autoIngest === accepted.autoIngest;

  const choose = async (): Promise<void> => {
    setPicking(true);
    setFailure(null);
    try {
      const chosen = await binding.chooseDirectory();
      if (chosen !== null) setDraft({ directory: chosen, autoIngest: value.autoIngest });
    } catch {
      setFailure("save");
    } finally {
      setPicking(false);
    }
  };

  const save = async (): Promise<void> => {
    const next = value.directory.trim();
    if (next !== "" && !next.startsWith("/")) {
      setFailure("invalid");
      return;
    }
    setFailure(null);
    try {
      const saved = await binding.save({ directory: next, autoIngest: value.autoIngest });
      if (saved) setDraft(null);
      else setFailure("save");
    } catch {
      setFailure("save");
    }
  };

  return <section className={styles.card} aria-label={t("okf")}>
    <div className={styles.heading}>
      <div>
        <h4 className={styles.title}>{t("okf")}</h4>
        <p className={styles.description}>{t("okfConsent")}</p>
      </div>
    </div>
    <div className={styles.downloadRouting}>
      <label><span className={styles.label}>{t("okfFolder")}</span>
        <Input value={value.directory} placeholder={t("transcriptFolderUnset")} autoComplete="off" spellCheck={false}
          disabled={!writable || picking}
          onChange={event => setDraft({ directory: event.target.value, autoIngest: value.autoIngest })} />
      </label>
      <div className={styles.runtimeRow}>
        <span className={styles.label}>{t("okfAutoIngest")}</span>
        <Switch checked={value.autoIngest} label={t("okfAutoIngest")} disabled={!writable || picking}
          onChange={next => setDraft({ directory: value.directory, autoIngest: next })} />
      </div>
    </div>
    <div className={styles.downloadActions}>
      <Button size="sm" variant="outline" disabled={!writable || picking} onClick={() => { void choose(); }}>
        {t("chooseFolder")}
      </Button>
      <Button size="sm" disabled={!writable || picking || unchanged}
        onClick={() => { void save(); }}>{t("save")}</Button>
    </div>
    {failure === null ? null : <p className={styles.error} role="status">
      {t(failure === "invalid" ? "transcriptFolderInvalid" : "okfSaveFailed")}
    </p>}
  </section>;
}

/**
 * Default folder for exported transcripts and the Open knowledge base section.
 * The macOS chooser runs on the host, so the same dialog is available from the
 * recording panel when no folder is configured yet.
 */
export function TranscriptSettings({ form, rpc, t, okf }: Props) {
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

  const chooseOkf = async (): Promise<string | null> => {
    const result = await callRecordingRpc(rpc, "transcripts/choose-directory", {});
    if (result.ok && typeof result.value === "string") return result.value;
    if (!result.ok && result.error.message === "CANCELLED_BY_USER") return null;
    throw new Error("OKF_DIRECTORY_PICK_FAILED");
  };

  const saveOkf = async (next: OkfSettingsValues): Promise<boolean> => {
    if (form?.state.revision === undefined) return false;
    try {
      return await form.mutate([
        { op: "set", path: ["okf_directory"], value: next.directory },
        { op: "set", path: ["okf_auto_ingest"], value: next.autoIngest },
      ], form.state.revision);
    } catch {
      return false;
    }
  };

  const okfBinding: OkfSettingsBinding = okf ?? {
    ...okfAccepted(form?.state.value),
    writable,
    chooseDirectory: chooseOkf,
    save: saveOkf,
  };

  return <>
    <section className={styles.card}>
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
    </section>
    <OkfSettingsSection binding={okfBinding} t={t} />
  </>;
}
