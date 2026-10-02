import { Button, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PanelViewProps } from "./RecordingPanelView.js";
import { recordingIcons, recordingWavePaths } from "./recording-icon-assets.js";
import styles from "./RecordingPanel.module.css";

export function RecordingIcon({ name }: { readonly name: keyof typeof recordingIcons }) {
  const asset = recordingIcons[name];
  return name === "stop" ? <img className={styles.actionIcon} src={asset} alt="" />
    : <span aria-hidden="true" className={`${styles.icon} ${styles[name] ?? ""}`}
      style={{ maskImage: `url("${asset}")` }} />;
}

function Wave({ view, translate }: Pick<PanelViewProps, "view" | "translate">) {
  const moving = view?.phase === "recording" && (view.mic.state === "on" || view.system.state === "on");
  return <svg className={styles.wave} data-recording-wave={moving ? "moving" : "still"}
    viewBox="0 0 18 18" width="18" height="18" role="img" aria-label={translate("panel.activity")}>
    {recordingWavePaths.map((path, index) => <path key={index} d={path} fill="currentColor" />)}
  </svg>;
}

function MainControl({ pending, pendingAction, run, translate, view }: Pick<PanelViewProps, "pending" | "pendingAction" | "run" | "translate" | "view">) {
  const recording = view?.phase === "recording";
  const busyPhase = pendingAction === "start" ? "starting" : pendingAction === "stop" ? "finalizing"
    : view?.phase === "starting" || view?.phase === "finalizing" ? view.phase : null;
  const busy = busyPhase !== null;
  const label = translate(busyPhase !== null ? `phase.${busyPhase}` : recording ? "panel.stop" : view ? "panel.startNew" : "panel.start");
  return <Tooltip label={label}>
    <Button variant="ghost" className={styles.mainControl} aria-label={label}
      disabled={pending || busy} onClick={() => void run(recording && view
        ? { action: "stop", meeting_id: view.meetingId } : { action: "start" })}>
      {busy ? <span className={styles.spinner} aria-hidden="true" />
        : <RecordingIcon name={recording ? "stop" : "play"} />}
      {recording && !busy && <Wave view={view} translate={translate} />}
    </Button>
  </Tooltip>;
}

function TrackButton({ pending, pendingAction, run, track, translate, view }: Pick<PanelViewProps, "pending" | "pendingAction" | "run" | "translate" | "view"> & {
  readonly track: "mic" | "system";
}) {
  const state = view?.[track];
  const available = view?.phase === "recording" && pendingAction !== "stop";
  const requested = available && (state?.requested ?? false);
  const action = track === "mic"
    ? requested ? "mic_off" as const : "mic_on" as const
    : requested ? "system_off" as const : "system_on" as const;
  const label = translate(track === "mic"
    ? requested ? "panel.micOn" : "panel.micOff"
    : requested ? "panel.systemOn" : "panel.systemOff");
  const icon = track === "mic" ? requested ? "mic" : "micOff" : requested ? "system" : "systemOff";
  return <Tooltip label={label}>
    <Button variant="ghost" className={`${styles.control} ${!requested ? styles.off : ""} ${available && state?.errorCode != null ? styles.warning : ""}`}
      aria-label={label} aria-pressed={requested} disabled={pending || !available}
      onClick={() => view && void run({ action, meeting_id: view.meetingId })}>
      <RecordingIcon name={icon} />
    </Button>
  </Tooltip>;
}

export function RecordingControls(props: PanelViewProps) {
  const canReference = props.hasRecordingHistory || props.view?.recordingStartedAtMs != null;
  return <>
    <MainControl {...props} />
    <TrackButton {...props} track="mic" /><TrackButton {...props} track="system" />
    <Tooltip label={props.translate("panel.join")}>
      <Button variant="ghost" className={`${styles.control} ${!canReference ? styles.off : ""}`}
        aria-label={props.translate("panel.join")} disabled={props.pending || !canReference}
        onClick={() => void props.join()}><RecordingIcon name="mention" /></Button>
    </Tooltip>
  </>;
}
