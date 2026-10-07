import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";

import type {
  RecordingRpcControlPayload,
  RecordingRpcSegment,
  RecordingRpcView,
} from "../recording/rpc-contract.js";
import type { MeetingReferenceLocaleKey } from "./meeting-reference-locales.js";
import { RecordingPanelView } from "./RecordingPanelView.js";
import { RecordingRpcClient } from "./recording-rpc-client.js";

const POLL_MS = 2_000;

export type RecordingPendingAction = RecordingRpcControlPayload["action"] | "join" | null;

export type Translate = (
  key: MeetingReferenceLocaleKey,
  params?: Readonly<Record<string, string>>,
) => string;

export interface RecordingReferenceActions {
  join(view: RecordingRpcView | null): Promise<void>;
  observeRecording(view: RecordingRpcView | null): void;
  recordingStarted(view: RecordingRpcView, sessionId?: string): Promise<void>;
}

interface LocaleFace {
  getSnapshot(): { readonly revision: number };
  subscribe(listener: () => void): () => void;
}

function trackError(view: RecordingRpcView | null): string | null {
  if (view?.mic.errorCode !== null && view?.mic.errorCode !== undefined) return view.mic.errorCode;
  if (view?.system.errorCode !== null && view?.system.errorCode !== undefined) return view.system.errorCode;
  return view?.errorCode ?? null;
}

interface RecordingPanelProps {
  readonly currentSessionId: () => string | undefined;
  readonly locale: LocaleFace;
  readonly references: RecordingReferenceActions;
  readonly rpc: ClientConnectionRpc;
  readonly translate: Translate;
}

function useRecordingSnapshot(client: RecordingRpcClient, references: RecordingReferenceActions) {
  const mounted = useRef(true);
  const [view, setView] = useState<RecordingRpcView | null>(null);
  const [hasRecordingHistory, setHasRecordingHistory] = useState(false);
  const [preview, setPreview] = useState<readonly RecordingRpcSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const latestRefresh = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const request = ++latestRefresh.current;
    const state = await client.state(signal);
    if (!mounted.current || request !== latestRefresh.current) return;
    setReadError(null);
    setView(state.recording);
    setPreview(state.preview);
    setHasRecordingHistory(state.hasRecordingHistory);
    references.observeRecording(state.recording);
  }, [client, references]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const tick = () => void refresh(controller.signal).catch((cause: unknown) => {
      if (mounted.current && !controller.signal.aborted) {
        setReadError(cause instanceof Error ? cause.message : "ENGINE_FAILURE");
      }
    });
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      mounted.current = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);
  return { error: error ?? readError, hasRecordingHistory, mounted, preview, refresh, setError, setView, view };
}

function useRecordingControl(options: {
  readonly client: RecordingRpcClient;
  readonly currentSessionId: () => string | undefined;
  readonly mounted: React.RefObject<boolean>;
  readonly references: RecordingReferenceActions;
  readonly refresh: (signal?: AbortSignal) => Promise<void>;
  readonly setError: (value: string | null) => void;
  readonly setPending: (value: RecordingPendingAction) => void;
  readonly setView: (value: RecordingRpcView) => void;
}) {
  const generation = useRef(0);
  return useCallback(async (payload: RecordingRpcControlPayload) => {
    const request = ++generation.current;
    let settled = false;
    const { client, currentSessionId, mounted, references, refresh } = options;
    const startSessionId = payload.action === "start" ? currentSessionId() : undefined;
    options.setPending(payload.action);
    options.setError(null);
    try {
      const next = await client.control(payload);
      if (!mounted.current) return;
      options.setView(next);
      options.setPending(null);
      settled = true;
      if (payload.action === "start") await references.recordingStarted(next, startSessionId);
      else references.observeRecording(next);
      await refresh();
    } catch (cause) {
      if (mounted.current && generation.current === request) options.setError(cause instanceof Error ? cause.message : "ENGINE_FAILURE");
    } finally {
      if (mounted.current && !settled && generation.current === request) options.setPending(null);
    }
  }, [options]);
}

function useJoinReference(options: {
  readonly mounted: React.RefObject<boolean>;
  readonly references: RecordingReferenceActions;
  readonly setError: (value: string | null) => void;
  readonly setPending: (value: RecordingPendingAction) => void;
  readonly translate: Translate;
  readonly view: RecordingRpcView | null;
}) {
  return useCallback(async () => {
    options.setPending("join");
    options.setError(null);
    try {
      await options.references.join(options.view);
    } catch (cause) {
      if (options.mounted.current) {
        const code = cause instanceof Error ? cause.message : "ENGINE_FAILURE";
        options.setError(code === "NO_SESSION_AVAILABLE" ? options.translate("panel.noSession") : code);
      }
    } finally {
      if (options.mounted.current) options.setPending(null);
    }
  }, [options]);
}

export function RecordingPanel(props: RecordingPanelProps) {
  const { currentSessionId, locale, references, rpc, translate } = props;
  useSyncExternalStore(listener => locale.subscribe(listener), () => locale.getSnapshot());
  const client = useMemo(() => new RecordingRpcClient(rpc), [rpc]);
  const snapshot = useRecordingSnapshot(client, references);
  const prepare = useCallback((signal: AbortSignal) => client.prepareModels(signal), [client]);
  const [pendingAction, setPending] = useState<RecordingPendingAction>(null);
  useEffect(() => {
    if (pendingAction !== "stop") return;
    const controller = new AbortController();
    const timer = setInterval(() => void snapshot.refresh(controller.signal).catch(() => undefined), 200);
    return () => { controller.abort(); clearInterval(timer); };
  }, [pendingAction, snapshot.refresh]);
  const run = useRecordingControl({
    client, currentSessionId, mounted: snapshot.mounted, references,
    refresh: snapshot.refresh, setError: snapshot.setError, setPending, setView: snapshot.setView,
  });
  const join = useJoinReference({
    mounted: snapshot.mounted, references, setError: snapshot.setError,
    setPending, translate, view: snapshot.view?.recordingStartedAtMs === null ? null : snapshot.view,
  });
  const failure = snapshot.error ?? trackError(snapshot.view);
  return <RecordingPanelView failure={failure} join={join} pending={pendingAction !== null} pendingAction={pendingAction}
    hasRecordingHistory={snapshot.hasRecordingHistory} prepare={prepare}
    preview={snapshot.preview} run={run} translate={translate} view={snapshot.view} />;
}
