import { useEffect, useState } from "react";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import { Button, StateDot } from "@deepseek-ai/dsh-client-ui-primitives";
import { callRecordingRpc } from "./recording-rpc-transport.js";
import { parseRecordingPermissions, type RecordingPermissions } from "../recording/permission-contract.js";
import type { ModelSettingsTranslate } from "./model-settings-locales.js";
import styles from "./ModelSettingsPage.module.css";

async function permissions(rpc: ClientConnectionRpc, test: boolean, signal: AbortSignal) {
  const response = await callRecordingRpc(rpc, test ? "permissions/test" : "permissions/status", {}, signal);
  if (!response.ok) throw new Error("PERMISSION_CHECK_FAILED");
  return parseRecordingPermissions(response.value);
}

export function RecordingPermissionSettings({ rpc, t }: { rpc: ClientConnectionRpc; t: ModelSettingsTranslate }) {
  const [status, setStatus] = useState<RecordingPermissions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [test, setTest] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    void permissions(rpc, test > 0, controller.signal).then(value => {
      if (!controller.signal.aborted) { setStatus(value); setError(false); setBusy(false); }
    }, () => { if (!controller.signal.aborted) { setError(true); setBusy(false); } });
    return () => controller.abort();
  }, [rpc, test]);
  async function open(track: "microphone" | "system") {
    try {
      const result = await callRecordingRpc(rpc, "permissions/open-settings", {track});
      if (!result.ok) setError(true);
    } catch { setError(true); }
  }
  const micReady = status?.microphone === "granted";
  const systemReady = status?.system === "verified";
  return <section className={styles.card} aria-label={t("permissions")}>
    <div className={styles.heading}><h3 className={styles.title}>{t("permissions")}</h3>
      <Button size="sm" disabled={busy} onClick={() => setTest(value => value + 1)}>{t(busy ? "permissionChecking" : "permissionTest")}</Button></div>
    <p className={styles.description}>{t("permissionHint")}</p>
    <div className={styles.diagnosticGroups}>
      <div className={styles.modelRow}><span>{t("microphone")}</span>
        <span><StateDot state={micReady ? "done" : "warning"} /> {t(micReady ? "permissionAllowed" : status === null ? "permissionUnknown" : "permissionNeeded")}</span>
        <Button size="sm" variant="ghost" onClick={() => void open("microphone")}>{t("openMicSettings")}</Button></div>
      <div className={styles.modelRow}><span>{t("systemAudio")}</span>
        <span><StateDot state={systemReady ? "done" : "warning"} /> {t(systemReady ? "permissionVerified" : status?.system === "unsupported" ? "permissionUnsupported" : test > 0 && status !== null ? "permissionUnverified" : "permissionUnknown")}</span>
        <Button size="sm" variant="ghost" onClick={() => void open("system")}>{t("openSystemSettings")}</Button></div>
    </div>
    <p className={styles.description}>{t("permissionSettingsHint")}</p>
    {error && <p className={styles.error} role="alert">{t("permissionFailed")}</p>}
  </section>;
}
