import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import type { AudioDeviceRpcEntry } from "../recording/rpc-contract.js";
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
  const moving = view?.phase === "recording" && [view.mic, view.system]
    .some(track => track.state === "on" && track.errorCode === null);
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
  const stopping = busyPhase === "finalizing" && view?.recordingEndedAtMs == null;
  const label = translate(stopping ? "panel.stopping" : busyPhase !== null ? `phase.${busyPhase}` : recording ? "panel.stop" : view ? "panel.startNew" : "panel.start");
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

function Chevron() {
  return <svg aria-hidden="true" viewBox="0 0 12 12" width="12" height="12" className={styles.caretIcon}>
    <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

/** The menu needs roughly this much room above the header before it flips below the control. */
const MENU_CLEARANCE = 260;

export function opensBelow(anchorTop: number, clearance = MENU_CLEARANCE): boolean {
  return anchorTop < clearance;
}

function DeviceMenu({ anchor, devices, menuRef, onChoose, onClose, selectedUID, track, translate }: {
  readonly anchor: HTMLElement | null;
  readonly devices: readonly AudioDeviceRpcEntry[] | null;
  readonly menuRef: React.RefObject<HTMLDivElement>;
  readonly onChoose: (uid: string) => void;
  readonly onClose: () => void;
  readonly selectedUID: string;
  readonly track: "mic" | "system";
  readonly translate: PanelViewProps["translate"];
}) {
  const options = devices?.filter(device => track === "mic" ? device.input_channels > 0 : device.output_channels > 0);
  const [below, setBelow] = useState(false);
  // The panel floats near the bottom of the window, so the menu normally opens upwards;
  // it flips below the control when there is not enough room above.
  useLayoutEffect(() => {
    if (anchor === null) return;
    setBelow(opensBelow(anchor.getBoundingClientRect().top));
  }, [anchor]);
  const item = (uid: string, name: string) => <button key={uid} type="button" role="menuitemradio"
    aria-checked={selectedUID === uid} className={styles.menuItem}
    onClick={() => { onChoose(uid); onClose(); }}>
    <span className={styles.menuCheck}>{selectedUID === uid ? "✓" : ""}</span>{name}
  </button>;
  return <div ref={menuRef} className={styles.menu} data-below={below ? "true" : undefined} role="menu"
    aria-label={translate(track === "mic" ? "panel.micDevice" : "panel.systemDevice")}>
    {item("", translate("panel.deviceDefault"))}
    {options === undefined
      ? <span className={styles.menuEmpty} role="menuitem" aria-disabled="true">{translate("panel.devicesUnavailable")}</span>
      : options.map(device => item(device.uid, device.name))}
  </div>;
}

function TrackButton({ devices, pending, pendingAction, refreshDevices, run, selectDevice, selectedDevices,
  track, translate, view }: PanelViewProps & { readonly track: "mic" | "system" }) {
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
  const selectedUID = track === "mic" ? selectedDevices.mic : selectedDevices.system;
  const [open, setOpen] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const toggleMenu = useCallback(() => {
    setOpen(current => !current);
    void refreshDevices();
  }, [refreshDevices]);
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      const target = event.target as Node;
      if (event instanceof MouseEvent && (group.current?.contains(target) === true
        || menu.current?.contains(target) === true)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [open]);
  const chooseDevice = (uid: string) => { void selectDevice(track, uid); };
  const selectedName = devices?.devices.find(device => device.uid === selectedUID)?.name;
  const caretLabel = translate(track === "mic" ? "panel.micDevice" : "panel.systemDevice");
  return <div className={styles.split} ref={group}>
    <Tooltip label={selectedName === undefined ? label : `${label} · ${selectedName}`}>
      <Button variant="ghost" className={`${styles.control} ${styles.splitMain} ${!requested ? styles.off : ""} ${available && state?.errorCode != null ? styles.warning : ""}`}
        aria-label={label} aria-pressed={requested} disabled={pending || !available}
        onClick={() => view && void run({ action, meeting_id: view.meetingId })}>
        <RecordingIcon name={icon} />
      </Button>
    </Tooltip>
    <Button variant="ghost" className={`${styles.caret} ${open ? styles.caretOpen : ""}`} aria-label={caretLabel}
      aria-haspopup="menu" aria-expanded={open} onClick={toggleMenu}>
      <Chevron />
    </Button>
    {open && <DeviceMenu anchor={group.current} devices={devices?.devices ?? null} menuRef={menu}
      selectedUID={selectedUID} track={track} translate={translate} onChoose={chooseDevice}
      onClose={() => setOpen(false)} />}
  </div>;
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
