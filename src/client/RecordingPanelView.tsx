import { Button, Tooltip, StateDot, IconWarningOutlineRegular, IconRefreshOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { StateDotState } from "@deepseek-ai/dsh-client-ui-primitives";
import type { RecordingRpcControlPayload, RecordingRpcSegment, RecordingRpcView } from "../recording/rpc-contract.js";
import { durationClock } from "./meeting-reference-source.js";
import type { RecordingPendingAction, Translate } from "./RecordingPanel.js";
import { RecordingControls, RecordingIcon } from "./RecordingPanelControls.js";
import { useRecordingPanelLayout } from "./use-recording-panel-layout.js";
import styles from "./RecordingPanel.module.css";

export interface PanelViewProps {
  readonly hasRecordingHistory: boolean;
  readonly failure: string | null;
  readonly join: () => Promise<void>;
  readonly pending: boolean;
  readonly pendingAction: RecordingPendingAction;
  readonly preview: readonly RecordingRpcSegment[];
  readonly run: (payload: RecordingRpcControlPayload) => Promise<void>;
  readonly translate: Translate;
  readonly view: RecordingRpcView | null;
}

function isActive(view: RecordingRpcView | null): boolean {
  return view?.phase === "starting" || view?.phase === "recording" || view?.phase === "finalizing";
}

function phaseState(view: RecordingRpcView | null): StateDotState {
  if (isActive(view)) return "ongoing";
  if (view?.phase === "failed") return "error";
  if (view?.phase === "partial") return "warning";
  return view?.phase === "completed" ? "done" : "idle";
}

function freshness(view: RecordingRpcView | null, translate: Translate): string {
  if (view?.latestDraftAtMs === null || view?.latestDraftAtMs === undefined) return translate("panel.draftWaiting");
  return translate("panel.draftFresh", {
    seconds: String(Math.max(0, Math.round((Date.now() - view.latestDraftAtMs) / 1_000))),
  });
}

function RecordingStatus({ pendingAction, translate, view }: Pick<PanelViewProps, "pendingAction" | "translate" | "view">) {
  const time = view?.durationMs ?? view?.recordingElapsedMs;
  const phase = pendingAction === "start" ? "starting" : pendingAction === "stop" ? "finalizing" : view?.phase;
  return <>
    <div className={styles.status} aria-live="polite">
      <span className={styles.phase}>
        {view?.phase === "completed" ? <RecordingIcon name="check" /> : <StateDot size={6} state={phaseState(view)} />}
        {phase === undefined ? translate("panel.phase.none") : translate(`phase.${phase}`)}
      </span>
      {time !== null && time !== undefined && <span className={styles.hint}>{durationClock(time)}</span>}
    </div>
    {view !== null && <div className={styles.tracks}>
      {(["mic", "system"] as const).map(track => <span key={track}
        className={`${styles.chip} ${view[track].errorCode !== null ? styles.warning : ""}`}>
        {translate(track === "mic" ? "panel.mic" : "panel.system")} {translate(
          view[track].errorCode === "SYSTEM_AUDIO_NO_SIGNAL" ? "panel.track.noSignal" : `panel.track.${view[track].state}`)}
      </span>)}
    </div>}
  </>;
}

function Preview({ preview, translate, view }: Pick<PanelViewProps, "preview" | "translate" | "view">) {
  return <div className={styles.preview} aria-label={translate("panel.previewAria")}>
    <div className={styles.previewHeading}>
      <span className={styles.previewTitle}>{translate("panel.previewAria")}</span>
      <span className={styles.chip}>{translate("panel.previewSpeaker")}</span>
    </div>
    <div className={styles.segments}>
      {preview.length === 0 && <span className={styles.hint}>
        {translate(view === null ? "panel.readyHint" : "panel.draftWaiting")}
      </span>}
      {preview.map(segment => <div className={styles.segment} key={segment.seq}>
        <span className={styles.segmentMeta}>{durationClock(segment.startMs)}
          {segment.speakerLabel !== null && ` · ${segment.speakerLabel}`}</span>
        <span className={styles.text}>{segment.text}</span>
      </div>)}
    </div>
  </div>;
}

function FooterStatus({ translate, view }: Pick<PanelViewProps, "translate" | "view">) {
  const text = isActive(view) ? view?.draftStale ? translate("panel.draftStale") : freshness(view, translate)
    : view?.finalizationMs === null || view?.finalizationMs === undefined ? translate("panel.previewHint")
      : translate("panel.finalization", { seconds: String(Math.round(view.finalizationMs / 100) / 10) });
  return <span className={`${styles.hint} ${view?.draftStale ? styles.warning : ""}`}>{text}</span>;
}

export function RecordingPanelView(props: PanelViewProps) {
  const { translate } = props;
  const noSignal = props.failure === "SYSTEM_AUDIO_NO_SIGNAL";
  const failure = props.failure === "SYSTEM_AUDIO_NO_SIGNAL" ? translate("panel.systemNoSignal")
    : props.failure === "MICROPHONE_PERMISSION_DENIED" ? translate("panel.micDenied")
      : props.failure === "SYSTEM_AUDIO_PERMISSION_DENIED" ? translate("panel.systemDenied") : props.failure;
  const compactWidth = 260 + (failure === null ? 0 : 32);
  const layout = useRecordingPanelLayout(compactWidth);
  const toggleLabel = translate(layout.expanded ? "panel.collapse" : "panel.expand");
  return <section className={styles.panel} data-expanded={layout.expanded} style={layout.style} aria-label={translate("panel.aria")}>
    <header className={styles.header}>
      <Button className={styles.move} aria-label={translate("panel.move")} {...layout.move}><RecordingIcon name="grip" /></Button>
      <RecordingControls {...props} />
      <span className={styles.spacer} />
      {failure !== null && <Tooltip label={failure}>
        <Button size="sm" className={`${styles.errorControl} ${noSignal ? styles.noSignal : ""}`} aria-label={failure}
          icon={<IconWarningOutlineRegular />} onClick={() => !layout.expanded && layout.toggle()} />
      </Tooltip>}
      <Button className={styles.toggle} aria-label={toggleLabel} aria-expanded={layout.expanded}
        onClick={layout.toggle}><RecordingIcon name={layout.expanded ? "collapse" : "expand"} /></Button>
    </header>
    {layout.expanded && <>
      <div className={styles.body}>
        <RecordingStatus {...props} />
        {failure !== null && <div className={`${styles.error} ${noSignal ? styles.noSignal : ""}`} role="alert">{failure}</div>}
        <Preview {...props} />
      </div>
      <footer className={styles.footer}>
        <FooterStatus {...props} />
        <Tooltip label={translate("panel.reset")}>
          <Button size="sm" className={styles.utility} aria-label={translate("panel.reset")} icon={<IconRefreshOutlineRegular />} onClick={layout.reset} />
        </Tooltip>
        <Button className={styles.resize} aria-label={translate("panel.resize")} {...layout.resize}><RecordingIcon name="resize" /></Button>
      </footer>
    </>}
  </section>;
}
