import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { Translate } from "./RecordingPanel.js";
import styles from "./RecordingPanel.module.css";

export type RecognizerEngine = "paraformer" | "parakeet";

function engineOf(value: Record<string, unknown> | undefined): RecognizerEngine {
  return value?.asr_engine === "parakeet" ? "parakeet" : "paraformer";
}

interface RecognizerSelectProps {
  readonly revision?: number | undefined;
  readonly settings: ConfigForm<Record<string, unknown>> | undefined;
  readonly translate: Translate;
}

/**
 * Recognizer family switch for the next recording. The choice is the profile
 * `asr_engine` setting, so it stays in step with the plugin settings page, and
 * it is read on every render instead of subscribed so this panel stays a pure
 * view of the recording state.
 */
export function RecognizerSelect(props: RecognizerSelectProps) {
  const { revision, settings, translate } = props;
  const snapshot = settings?.getSnapshot();
  const engine = engineOf(snapshot?.value);
  const selectable = settings !== undefined && snapshot?.writable === true && snapshot.status === "ready";
  const label = translate("panel.recognizer");
  const change = (value: string): void => {
    const next: RecognizerEngine = value === "parakeet" ? "parakeet" : "paraformer";
    const fence = revision ?? snapshot?.revision;
    if (settings === undefined || !selectable || next === engine || fence === undefined) return;
    void settings.mutate([{ op: "set", path: ["asr_engine"], value: next }], fence)
      .catch(() => undefined);
  };
  return <label className={styles.recognizer} title={translate("panel.recognizerHint")}>
    <span className={styles.recognizerLabel}>{label}</span>
    <select className={styles.recognizerSelect} defaultValue={engine} disabled={!selectable}
      aria-label={label} onChange={event => change(event.target.value)}>
      <option value="paraformer">{translate("panel.recognizerParaformer")}</option>
      <option value="parakeet">{translate("panel.recognizerParakeet")}</option>
    </select>
  </label>;
}
