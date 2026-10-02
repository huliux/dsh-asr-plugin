import { expect, it, vi } from "vitest";

import type { Context as ClientContext } from "@deepseek-ai/cordis";

import { MeetingReferenceCoordinator } from "../../src/client/meeting-reference-coordinator.js";
import type { RecordingRpcView } from "../../src/recording/rpc-contract.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";

class TestStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function recording(phase: RecordingRpcView["phase"] = "recording"): RecordingRpcView {
  return {
    draftRevision: 1,
    draftStale: false,
    errorCode: null,
    finalizationMs: null,
    jobId: "job-1",
    latestAudioAtMs: null,
    latestDraftAtMs: null,
    meetingId: MEETING_ID,
    mic: { errorCode: null, requested: true, state: "on" },
    phase,
    recordingStartedAtMs: 1_000,
    recordingEndedAtMs: phase === "completed" ? 2_000 : null,
    recordingElapsedMs: phase === "completed" ? 1_000
      : ["starting", "recording", "finalizing"].includes(phase) ? 500 : null,
    durationMs: phase === "completed" ? 5_000 : null,
    resultStatus: phase === "completed" ? "completed" : null,
    system: { errorCode: null, requested: true, state: "on" },
    transcriptVersion: phase === "completed" ? 1 : null,
  };
}

it("opens the native meeting picker without choosing a meeting or changing the draft", async () => {
  const harness = inputHarness();
  const scope = {};
  const toggleSource = vi.fn();
  const openSession = vi.fn();
  const ctx = {
    sessions: {
      list: { subscribe: () => vi.fn(), getSnapshot: () => ({
        phase: "ready", current: "session-1", ids: ["session-1"],
        byId: { "session-1": { id: "session-1", retainedBy: { mainView: 1 } } },
      }) },
      scope: () => scope,
    },
    conversation: { input: { for: () => harness.input } },
    inputTriggers: { sessionOf: () => ({ toggleSource }) },
    uiWorkspace: { openSession },
  } as unknown as ClientContext;
  const coordinator = new MeetingReferenceCoordinator({ ctx, client: {} as never,
    storage: new TestStorage(), translate: key => key });
  try {
    await coordinator.join(null);
    expect(openSession).toHaveBeenCalledWith("session-1");
    expect(openSession.mock.invocationCallOrder[0])
      .toBeLessThan(toggleSource.mock.invocationCallOrder[0]!);
    expect(toggleSource).toHaveBeenCalledWith("meeting-reference", {
      trigger: "@", query: "", quoted: false, position: "inline",
      span: { start: 0, end: 0, draftRev: 0 },
    });
    expect(harness.input.insertReference).not.toHaveBeenCalled();
    expect(harness.snapshot().draft).toBe("");
  } finally { coordinator.dispose(); }
});

function inputHarness() {
  let snapshot = {
    draft: "",
    draftRev: 0,
    occurrences: [] as Array<{ source: string; ref: string }>,
    phase: "plain" as "plain" | "submitting",
  };
  const listeners = new Set<() => void>();
  const publish = (next: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };
  return {
    input: {
      focus: vi.fn(),
      insertReference: vi.fn((reference) => {
        publish({
          draft: `${snapshot.draft}@${reference.label} `,
          draftRev: snapshot.draftRev + 1,
          occurrences: [...snapshot.occurrences, { source: reference.source, ref: reference.ref }],
        });
        return true;
      }),
      state: {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    publish,
    snapshot: () => snapshot,
  };
}

it("闭合录音自动加入、发送补回、删除抑制、@加入恢复与终态清理", async () => {
  const storage = new TestStorage();
  const harness = inputHarness();
  const scope = {};
  const sessionList = {
    byId: { "session-1": { id: "session-1", retainedBy: { mainView: 1 } } },
    current: "session-1",
    ids: ["session-1"],
    phase: "ready",
  };
  const ctx = {
    conversation: { input: { for: () => harness.input } },
    sessions: {
      list: { getSnapshot: () => sessionList, subscribe: () => vi.fn() },
      open: vi.fn(),
      scope: () => scope,
    },
    workspaces: { list: { getSnapshot: () => ({ recentWorkspaceId: undefined }) } },
    uiWorkspace: { openSession: vi.fn() },
  } as unknown as ClientContext;
  const client = {
    resolveMeetingReference: vi.fn(async () => ({ meeting_id: MEETING_ID, label: "产品周会" })),
  };
  const coordinator = new MeetingReferenceCoordinator({
    client: client as never,
    ctx,
    storage,
    translate: (key) => key,
  });

  await coordinator.recordingStarted(recording(), "session-1");
  expect(harness.snapshot().occurrences).toHaveLength(1);
  expect(storage.getItem("dsh-asr:meeting-reference:session-1"))
    .toBe(`{"meeting_id":"${MEETING_ID}","mode":"auto"}`);

  harness.publish({ phase: "submitting" });
  harness.publish({ draft: "", draftRev: 2, occurrences: [], phase: "plain" });
  await vi.waitFor(() => expect(harness.snapshot().occurrences).toHaveLength(1));

  harness.publish({ draft: "", draftRev: 3, occurrences: [], phase: "plain" });
  expect(storage.getItem("dsh-asr:meeting-reference:session-1")).toContain("suppressed");
  await coordinator.join(recording());
  expect(harness.snapshot().occurrences).toHaveLength(1);
  expect(storage.getItem("dsh-asr:meeting-reference:session-1")).toContain("auto");

  coordinator.observeRecording(recording("completed"));
  expect(storage.getItem("dsh-asr:meeting-reference:session-1")).toBeNull();
  expect(harness.snapshot().occurrences).toHaveLength(1);
  coordinator.dispose();
});

it.each([false, true])("无当前 Session 时 @加入 复用 DSH 创建并定位 Session（异步=%s）", async (asyncOpen) => {
  const storage = new TestStorage();
  const harness = inputHarness();
  const scope = {};
  const list: {
    byId: Record<string, { id: string; retainedBy: { mainView: number } }>;
    current: string | undefined;
    ids: string[];
    phase: "ready";
  } = { byId: {}, current: undefined, ids: [], phase: "ready" };
  const listeners = new Set<() => void>();
  const open = vi.fn((sessionId: string) => {
    list.current = sessionId;
    for (const listener of listeners) listener();
  });
  const startSession = vi.fn(() => {
    list.byId["session-2"] = { id: "session-2", retainedBy: { mainView: 1 } };
    list.ids.push("session-2");
    if (asyncOpen) queueMicrotask(() => open("session-2"));
    else open("session-2");
  });
  const ctx = {
    conversation: { input: { for: () => harness.input } },
    locale: { getLocale: () => ({ active: "zh" }) },
    sessions: {
      list: { getSnapshot: () => list, subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      } },
      open,
      scope: (sessionId: string) => list.byId[sessionId] === undefined ? undefined : scope,
    },
    uiWorkspace: { startSession },
  } as unknown as ClientContext;
  const coordinator = new MeetingReferenceCoordinator({
    client: {
      resolveMeetingReference: vi.fn(async () => ({ meeting_id: MEETING_ID, label: "产品周会" })),
    } as never,
    ctx,
    storage,
    translate: () => "当前录制会议",
  });

  await coordinator.join(recording());

  expect(startSession).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(1);
  expect(open).toHaveBeenCalledWith("session-2");
  expect(harness.snapshot().occurrences).toHaveLength(1);
  expect(storage.getItem("dsh-asr:meeting-reference:session-2")).toContain("auto");
  coordinator.dispose();
});

it("Host 已无活动录音时清理刷新遗留的 auto 状态", () => {
  const storage = new TestStorage();
  storage.setItem(
    "dsh-asr:meeting-reference:session-1",
    `{"meeting_id":"${MEETING_ID}","mode":"auto"}`,
  );
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => ({
          byId: { "session-1": { id: "session-1", retainedBy: { mainView: 1 } } },
          current: "session-1",
          ids: ["session-1"],
          phase: "ready",
        }),
        subscribe: () => vi.fn(),
      },
    },
  } as unknown as ClientContext;
  const coordinator = new MeetingReferenceCoordinator({
    client: {} as never,
    ctx,
    storage,
    translate: () => "当前录制会议",
  });

  coordinator.observeRecording(null);

  expect(storage.length).toBe(0);
  coordinator.dispose();
});
