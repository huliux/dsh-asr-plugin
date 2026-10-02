import { currentSessionId } from "./current-session.js";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";

import type { RecordingRpcView } from "../recording/rpc-contract.js";
import {
  reduceAutoReference,
  type AutoReferenceMode,
  type AutoReferenceReduction,
  type AutoReferenceRuntimeState,
} from "./meeting-reference-auto-state.js";
import {
  formatMeetingReference,
  parseMeetingReference,
  type MeetingReferenceIdentity,
} from "./meeting-reference-source.js";
import type { RecordingRpcClient } from "./recording-rpc-client.js";

const STORAGE_PREFIX = "dsh-asr:meeting-reference:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type SessionInput = ReturnType<ClientContext["conversation"]["input"]["for"]>;

interface PersistedReferenceState {
  readonly meetingId: string;
  readonly mode: AutoReferenceMode;
}

interface SessionTracker {
  readonly input: SessionInput;
  selfMutation: boolean;
  state: AutoReferenceRuntimeState;
  readonly unsubscribe: () => void;
}

class MemorySessionStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function defaultStorage(): Storage {
  try {
    return globalThis.sessionStorage ?? new MemorySessionStorage();
  } catch {
    return new MemorySessionStorage();
  }
}

type ActiveRecordingRpcView = RecordingRpcView & {
  readonly phase: "starting" | "recording" | "finalizing";
};

function active(view: RecordingRpcView | null): view is ActiveRecordingRpcView {
  return view !== null && ["starting", "recording", "finalizing"].includes(view.phase);
}

function keyFor(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`;
}

function parsePersisted(value: string | null): PersistedReferenceState | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      || Object.keys(parsed).length !== 2 || typeof parsed.meeting_id !== "string"
      || !UUID_PATTERN.test(parsed.meeting_id)
      || (parsed.mode !== "auto" && parsed.mode !== "suppressed")) return null;
    return { meetingId: parsed.meeting_id, mode: parsed.mode };
  } catch {
    return null;
  }
}

function hasReference(input: SessionInput, meetingId: string): boolean {
  return input.state.getSnapshot().occurrences.some((occurrence) => {
    if (occurrence.source !== "meeting-reference") return false;
    try {
      return parseMeetingReference(occurrence.ref).meetingId === meetingId;
    } catch {
      return false;
    }
  });
}

export class MeetingReferenceCoordinator {
  private readonly lifetime = new AbortController();
  private currentRecording: RecordingRpcView | null = null;
  private readonly insertions = new Map<string, Promise<void>>();
  private readonly storage: Storage;
  private readonly trackers = new Map<string, SessionTracker>();
  private readonly unsubscribeSessions: () => void;

  constructor(private readonly options: {
    readonly client: RecordingRpcClient;
    readonly ctx: ClientContext;
    readonly storage?: Storage;
    readonly translate: (key: "auto.current") => string;
  }) {
    this.storage = options.storage ?? defaultStorage();
    this.unsubscribeSessions = options.ctx.sessions.list.subscribe(() => this.reconcileSessions());
    this.reconcileSessions();
  }

  async recordingStarted(view: RecordingRpcView, sessionId?: string): Promise<void> {
    this.observeRecording(view);
    if (!active(view) || sessionId === undefined || !this.sessionExists(sessionId)) return;
    await this.activateSession(sessionId, view.meetingId);
  }

  observeRecording(view: RecordingRpcView | null): void {
    if (!active(view)) {
      this.currentRecording = null;
      this.retireOtherMeetings();
      return;
    }
    this.retireOtherMeetings(view.meetingId);
    this.currentRecording = view;
    this.restoreMeeting(view.meetingId);
  }

  async join(view: RecordingRpcView | null): Promise<void> {
    this.observeRecording(view);
    const sessionId = await this.addressSession();
    if (view === null) {
      const scope = this.options.ctx.sessions.scope(sessionId as SessionId);
      const input = this.inputFor(sessionId);
      if (scope === undefined || input === null) throw new Error("NO_SESSION_AVAILABLE");
      const { draft, draftRev } = input.state.getSnapshot();
      input.focus();
      this.options.ctx.inputTriggers.sessionOf(scope).toggleSource("meeting-reference", {
        trigger: "@", query: "", quoted: false, position: "inline",
        span: { start: draft.length, end: draft.length, draftRev },
      });
      return;
    }
    if (active(view)) await this.activateSession(sessionId, view.meetingId);
    else await this.insertOnce(sessionId, view.meetingId);
  }

  dispose(): void {
    this.lifetime.abort();
    this.unsubscribeSessions();
    for (const tracker of this.trackers.values()) tracker.unsubscribe();
    this.trackers.clear();
  }

  private async addressSession(): Promise<string> {
    const current = currentSessionId(this.options.ctx);
    if (current !== undefined) {
      this.options.ctx.uiWorkspace.openSession(current as SessionId);
      return current;
    }
    this.options.ctx.uiWorkspace.startSession();
    return this.waitForSession();
  }

  private waitForSession(): Promise<string> {
    const list = this.options.ctx.sessions.list;
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]);
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const cleanup = () => {
        unsubscribe();
        signal.removeEventListener("abort", abort);
      };
      const abort = () => { cleanup(); reject(new Error("NO_SESSION_AVAILABLE")); };
      const changed = () => {
        const current = currentSessionId(this.options.ctx);
        if (current !== undefined) { cleanup(); resolve(current); }
      };
      unsubscribe = list.subscribe(changed);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else changed();
    });
  }

  private async activateSession(sessionId: string, meetingId: string): Promise<void> {
    const tracker = this.trackers.get(sessionId) ?? this.attach(sessionId, { meetingId, mode: "auto" });
    if (tracker === null) return;
    const reduction = reduceAutoReference(tracker.state, { type: "join", meetingId });
    this.adopt(sessionId, reduction);
    if (reduction.effect === "insert") await this.ensureReference(sessionId);
  }

  private attach(sessionId: string, persisted: PersistedReferenceState): SessionTracker | null {
    const input = this.inputFor(sessionId);
    if (input === null) return null;
    const snapshot = input.state.getSnapshot();
    const reduction = reduceAutoReference(null, {
      type: "restore",
      inputPhase: snapshot.phase,
      meetingId: persisted.meetingId,
      mode: persisted.mode,
      present: hasReference(input, persisted.meetingId),
    });
    if (reduction.state === null) return null;
    const tracker: SessionTracker = {
      input,
      selfMutation: false,
      state: reduction.state,
      unsubscribe: input.state.subscribe(() => this.observeInput(sessionId)),
    };
    this.trackers.set(sessionId, tracker);
    this.writeState(sessionId, tracker.state);
    if (reduction.effect === "insert") void this.ensureReference(sessionId);
    return tracker;
  }

  private observeInput(sessionId: string): void {
    const tracker = this.trackers.get(sessionId);
    if (tracker === undefined) return;
    const snapshot = tracker.input.state.getSnapshot();
    const reduction = reduceAutoReference(tracker.state, {
      type: "observe",
      inputPhase: snapshot.phase,
      present: hasReference(tracker.input, tracker.state.meetingId),
      selfMutation: tracker.selfMutation,
    });
    this.adopt(sessionId, reduction);
    if (reduction.effect === "insert") void this.ensureReference(sessionId);
  }

  private adopt(sessionId: string, reduction: AutoReferenceReduction): void {
    const tracker = this.trackers.get(sessionId);
    if (tracker === undefined) return;
    if (reduction.state === null) {
      this.removeSession(sessionId);
      return;
    }
    tracker.state = reduction.state;
    this.writeState(sessionId, reduction.state);
  }

  private ensureReference(sessionId: string): Promise<void> {
    const pending = this.insertions.get(sessionId);
    if (pending !== undefined) return pending;
    const operation = this.doEnsureReference(sessionId).finally(() => {
      if (this.insertions.get(sessionId) === operation) this.insertions.delete(sessionId);
    });
    this.insertions.set(sessionId, operation);
    return operation;
  }

  private async doEnsureReference(sessionId: string): Promise<void> {
    const tracker = this.trackers.get(sessionId);
    const recording = this.currentRecording;
    if (tracker === undefined || tracker.state.mode !== "auto" || !active(recording)
      || recording.meetingId !== tracker.state.meetingId) return;
    const identity = await this.resolveIdentity(recording.meetingId);
    const current = this.trackers.get(sessionId);
    if (current !== tracker || current.state.mode !== "auto" || hasReference(current.input, identity.meetingId)) return;
    current.selfMutation = true;
    try {
      this.insert(current.input, identity);
    } finally {
      current.selfMutation = false;
    }
  }

  private async insertOnce(sessionId: string, meetingId: string): Promise<void> {
    const input = this.inputFor(sessionId);
    if (input === null || hasReference(input, meetingId)) return;
    this.insert(input, await this.resolveIdentity(meetingId));
  }

  private insert(input: SessionInput, identity: MeetingReferenceIdentity): void {
    const snapshot = input.state.getSnapshot();
    const mention = formatMeetingReference(identity);
    input.insertReference({
      source: "meeting-reference",
      ref: mention,
      label: identity.label,
      clipboardText: mention,
    }, { start: snapshot.draft.length, end: snapshot.draft.length, draftRev: snapshot.draftRev });
  }

  private async resolveIdentity(meetingId: string): Promise<MeetingReferenceIdentity> {
    try {
      const candidate = await this.options.client.resolveMeetingReference({
        locale: this.options.ctx.locale.getLocale().active,
        meeting_id: meetingId,
      });
      const identity = { meetingId: candidate.meeting_id, label: candidate.label };
      formatMeetingReference(identity);
      if (identity.meetingId === meetingId) return identity;
    } catch {
      // An active recording remains a trusted identity if its display lookup is transiently unavailable.
    }
    return { meetingId, label: this.options.translate("auto.current") };
  }

  private restoreMeeting(meetingId: string): void {
    for (const [sessionId, persisted] of this.persistedEntries()) {
      if (persisted.meetingId === meetingId && this.sessionExists(sessionId)
        && !this.trackers.has(sessionId)) this.attach(sessionId, persisted);
    }
  }

  private retireOtherMeetings(keepMeetingId?: string): void {
    for (const [sessionId, persisted] of this.persistedEntries()) {
      if (persisted.meetingId !== keepMeetingId) this.removeSession(sessionId);
    }
  }

  private reconcileSessions(): void {
    const list = this.options.ctx.sessions.list.getSnapshot();
    if (list.phase !== "ready") return;
    for (const [sessionId] of this.persistedEntries()) {
      if (list.byId[sessionId as SessionId] === undefined) this.removeSession(sessionId);
    }
  }

  private persistedEntries(): Array<[string, PersistedReferenceState]> {
    const entries: Array<[string, PersistedReferenceState]> = [];
    const keys = Array.from({ length: this.storage.length }, (_, index) => this.storage.key(index));
    for (const key of keys) {
      if (key === null || !key.startsWith(STORAGE_PREFIX)) continue;
      const sessionId = key.slice(STORAGE_PREFIX.length);
      const persisted = parsePersisted(this.storage.getItem(key));
      if (sessionId === "" || persisted === null) this.storage.removeItem(key);
      else entries.push([sessionId, persisted]);
    }
    return entries;
  }

  private inputFor(sessionId: string): SessionInput | null {
    const scope = this.options.ctx.sessions.scope(sessionId as SessionId);
    return scope === undefined ? null : this.options.ctx.conversation.input.for(scope);
  }

  private sessionExists(sessionId: string): boolean {
    return this.options.ctx.sessions.list.getSnapshot().byId[sessionId as SessionId] !== undefined;
  }

  private writeState(sessionId: string, state: AutoReferenceRuntimeState): void {
    this.storage.setItem(keyFor(sessionId), JSON.stringify({
      meeting_id: state.meetingId,
      mode: state.mode,
    }));
  }

  private removeSession(sessionId: string): void {
    this.trackers.get(sessionId)?.unsubscribe();
    this.trackers.delete(sessionId);
    this.storage.removeItem(keyFor(sessionId));
  }
}
