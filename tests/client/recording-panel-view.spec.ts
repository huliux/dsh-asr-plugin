import { isValidElement, useEffect, type ReactNode } from "react";
import { expect, it, vi } from "vitest";

vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), useEffect: vi.fn() }));

vi.mock("@deepseek-ai/dsh-client-ui-primitives", () => ({
  Button: () => null, Tooltip: () => null, StateDot: () => null,
  IconWarningOutlineRegular: () => null, IconRefreshOutlineRegular: () => null,
}));
const layoutState = vi.hoisted(() => ({ expanded: true }));
vi.mock("../../src/client/use-recording-panel-layout.js", () => ({
  useRecordingPanelLayout: () => ({ expanded: layoutState.expanded, style: {}, move: {}, resize: {},
    toggle: vi.fn(), reset: vi.fn() }),
}));

import { RecordingPanelView } from "../../src/client/RecordingPanelView.js";
import { en, zh } from "../../src/client/meeting-reference-locales.js";

function alertText(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(alertText).find(value => value !== undefined);
  if (!isValidElement<{ role?: string; children?: ReactNode }>(node)) return undefined;
  return node.props.role === "alert" ? node.props.children : alertText(node.props.children);
}

function renderedText(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(renderedText).join(" ");
  if (typeof node === "string") return node;
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";
  if (typeof node.type === "function") {
    const component = node.type as (props: unknown) => ReactNode;
    return renderedText(component(node.props));
  }
  return renderedText(node.props.children);
}

it.each([zh, en])("renders actionable no-signal copy without asserting permission denial", locale => {
  const result = RecordingPanelView({ hasRecordingHistory: false, failure: "SYSTEM_AUDIO_NO_SIGNAL",
    join: vi.fn(), pending: false, pendingAction: null, preview: [], run: vi.fn(), view: null,
    translate: key => locale[key] });
  expect(alertText(result)).not.toBe("SYSTEM_AUDIO_NO_SIGNAL");
  expect(alertText(result)).toContain(locale === zh ? "播放" : "playback");
  expect(alertText(result)).toContain(locale === zh ? "系统设置" : "System Settings");
});


it.each([zh, en])("shows both track problems instead of hiding system recovery behind a mic failure", locale => {
  const result = RecordingPanelView({ hasRecordingHistory: false, failure: "MICROPHONE_PERMISSION_DENIED",
    join: vi.fn(), pending: false, pendingAction: null, preview: [], run: vi.fn(),
    view: { draftRevision: 0, draftStale: false, errorCode: null, finalizationMs: null, jobId: "job",
      latestAudioAtMs: null, latestDraftAtMs: null, meetingId: "meeting",
      mic: { state: "failed", requested: true, errorCode: "MICROPHONE_PERMISSION_DENIED" },
      system: { state: "on", requested: true, errorCode: "SYSTEM_AUDIO_NO_SIGNAL" }, phase: "recording",
      recordingEndedAtMs: null, recordingElapsedMs: 27_000, recordingStartedAtMs: 0,
      durationMs: null, resultStatus: null, transcriptVersion: null },
    translate: key => locale[key] });
  const text = JSON.stringify(alertText(result));
  expect(text).toContain(locale["panel.micDenied"]);
  expect(text).toContain(locale["panel.systemNoSignal"]);
  expect(renderedText(result)).toContain(locale["panel.waitingForSound"]);
});

it.each([zh, en])("uses user language for model, worker and unknown errors", locale => {
  for (const code of ["MODEL_NOT_READY", "WORKER_PROTOCOL_ERROR", "HELPER_READY_TIMEOUT", "SOME_NEW_ERROR"]) {
    const result = RecordingPanelView({ hasRecordingHistory: false, failure: code,
      join: vi.fn(), pending: false, pendingAction: null, preview: [], run: vi.fn(), view: null,
      translate: key => locale[key] });
    expect(alertText(result)).not.toContain(code);
    expect(alertText(result)).toMatch(locale === zh ? /模型|组件|重试/ : /models|component|retry/i);
  }
});

it.each([zh, en])("separates stopping capture from final transcript processing", locale => {
  const props = { hasRecordingHistory: false, failure: null, join: vi.fn(), pending: true,
    pendingAction: "stop" as const, preview: [], run: vi.fn(), translate: (key: keyof typeof zh) => locale[key] };
  const recording = { draftRevision: 0, draftStale: false, errorCode: null, finalizationMs: null, jobId: "job",
    latestAudioAtMs: null, latestDraftAtMs: null, meetingId: "meeting", mic: { state: "on" as const, requested: true, errorCode: null },
    system: { state: "on" as const, requested: true, errorCode: null }, phase: "finalizing" as const,
    recordingEndedAtMs: null, recordingElapsedMs: 100, recordingStartedAtMs: 1,
    durationMs: null, resultStatus: null, transcriptVersion: null };
  expect(renderedText(RecordingPanelView({ ...props, view: recording })))
    .toContain(locale === zh ? "正在停止录音" : "Stopping recording");
  expect(renderedText(RecordingPanelView({ ...props, view: { ...recording, recordingEndedAtMs: 101 } })))
    .toContain(locale === zh ? "正在整理转写" : "Preparing transcript");
});

it("prepares models only when expanded and cancels the wait on unmount", async () => {
  const prepare = vi.fn(async (_signal: AbortSignal) => {});
  const props = { hasRecordingHistory: false, failure: null, join: vi.fn(), pending: false,
    pendingAction: null, preview: [], run: vi.fn(), view: null, translate: (key: keyof typeof zh) => zh[key], prepare };
  vi.mocked(useEffect).mockClear();
  layoutState.expanded = false;
  try {
    RecordingPanelView(props);
    expect(vi.mocked(useEffect).mock.calls[0]![0]()).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
    vi.mocked(useEffect).mockClear();
    layoutState.expanded = true;
    RecordingPanelView(props);
    const cleanup = vi.mocked(useEffect).mock.calls[0]![0]();
    const signal = prepare.mock.calls[0]![0];
    expect(signal.aborted).toBe(false);
    if (typeof cleanup !== "function") throw new Error("missing cleanup");
    cleanup();
    expect(signal.aborted).toBe(true);
  } finally { layoutState.expanded = true; }
});
