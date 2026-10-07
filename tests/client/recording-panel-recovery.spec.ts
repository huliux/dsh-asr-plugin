import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import { beforeEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as Array<() => () => void> }));
vi.mock("react", () => ({
  useSyncExternalStore: vi.fn(), useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn, useRef: () => ({ current: true }),
  useEffect: (effect: () => () => void) => hooks.effects.push(effect),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.cells)) hooks.cells[index] = initial;
    return [hooks.cells[index], (value: unknown) => {
      hooks.cells[index] = typeof value === "function" ? value(hooks.cells[index]) : value;
    }];
  },
}));
vi.mock("../../src/client/RecordingPanelView.js", () => ({ RecordingPanelView: () => null }));
import { RecordingPanel } from "../../src/client/RecordingPanel.js";
function fixture() {
  const call = vi.fn().mockRejectedValueOnce(new Error("network unavailable"))
    .mockResolvedValue({ ok: true, value: { recording: null, preview: [], hasRecordingHistory: false } });
  const props = { rpc: { call } as ClientConnectionRpc, currentSessionId: () => undefined,
    locale: { subscribe: vi.fn(), getSnapshot: () => ({ revision: 0 }) }, translate: (key: string) => key,
    references: { observeRecording: vi.fn(), recordingStarted: vi.fn(), join: vi.fn() } };
  const render = () => { hooks.cursor = 0; return RecordingPanel(props).props; };
  return { call, render, references: props.references };
}
beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; });
it("clears a recovered read error while retaining an action failure", async () => {
  vi.useFakeTimers();
  const page = fixture(); page.render();
  const cleanup = hooks.effects[0]!();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(page.render().failure).toBe("network unavailable");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(page.render().failure).toBeNull();
    page.call.mockResolvedValueOnce({ ok: false, error: { message: "MIC_PERMISSION_DENIED" } });
    await page.render().run({ action: "start" });
    expect(page.render().failure).toBe("MIC_PERMISSION_DENIED");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(page.render().failure).toBe("MIC_PERMISSION_DENIED");
  } finally { cleanup(); vi.useRealTimers(); }
});

it("enables controls after recording starts while reference registration is still pending", async () => {
  const page = fixture();
  const view = { meetingId: "11111111-1111-4111-8111-111111111111", jobId: "job", phase: "recording",
    mic: { requested: true, state: "on", errorCode: null }, system: { requested: true, state: "on", errorCode: null },
    draftRevision: 0, draftStale: false, latestAudioAtMs: null, latestDraftAtMs: null,
    recordingStartedAtMs: 1, recordingEndedAtMs: null, recordingElapsedMs: 0, durationMs: null,
    transcriptVersion: null, resultStatus: null, finalizationMs: null, errorCode: null };
  page.call.mockReset().mockResolvedValue({ ok: true, value: { recording: view, preview: [], hasRecordingHistory: true } })
    .mockResolvedValueOnce({ ok: true, value: view });
  let release!: () => void;
  page.references.recordingStarted.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const action = page.render().run({ action: "start" });
  await new Promise(resolve => setTimeout(resolve, 0));
  try { expect(page.render().pending).toBe(false); }
  finally { release(); await action; }
});
