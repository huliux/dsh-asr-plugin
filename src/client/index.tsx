import type {} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { ModelSettingsPage } from "./ModelSettingsPage.js";
import { MODEL_SETTINGS_NAMESPACE, modelZh, modelEn } from "./model-settings-locales.js";
import { currentSessionId } from "./current-session.js";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";

import { RecordingPanel } from "./RecordingPanel.js";
import { MeetingReferenceCoordinator } from "./meeting-reference-coordinator.js";
import {
  en,
  MEETING_REFERENCE_LOCALE_NAMESPACE,
  zh,
} from "./meeting-reference-locales.js";
import {
  createMeetingReferenceSource,
  parseMeetingReference,
} from "./meeting-reference-source.js";
import { RecordingRpcClient } from "./recording-rpc-client.js";

export const inject = [
  "slots", "connection", "inputTriggers", "locale", "sessions", "uiWorkspace", "conversation",
];

function hasMeetingReference(ctx: ClientContext, sessionId: string, meetingId: string): boolean {
  const session = ctx.sessions.scope(sessionId as SessionId);
  if (session === undefined) return false;
  return ctx.conversation.input.for(session).state.getSnapshot().occurrences.some((occurrence) => {
    if (occurrence.source !== "meeting-reference") return false;
    try {
      return parseMeetingReference(occurrence.ref).meetingId === meetingId;
    } catch {
      return false;
    }
  });
}

export function apply(ctx: ClientContext): void {
  const connection = ctx.get("connection") as ConnectionHandle;
  const client = new RecordingRpcClient(connection.rpc);
  ctx.effect(() => ctx.locale.register(
    MEETING_REFERENCE_LOCALE_NAMESPACE,
    { zh, en },
  ), "dsh-asr: meeting reference dictionaries");
  const translate = ctx.locale.bind(MEETING_REFERENCE_LOCALE_NAMESPACE);
  const references = new MeetingReferenceCoordinator({
    client,
    ctx,
    translate,
  });
  ctx.effect(() => () => references.dispose(), "dsh-asr: meeting reference coordinator");
  const source = createMeetingReferenceSource({
    client,
    hasReference: (sessionId, meetingId) => hasMeetingReference(ctx, sessionId, meetingId),
    locale: () => ctx.locale.getLocale().active,
    translate,
  });
  ctx.effect(
    () => ctx.inputTriggers.registerSource(source),
    "dsh-asr: meeting reference source",
  );
  ctx.effect(() => ctx.locale.register(MODEL_SETTINGS_NAMESPACE, { zh: modelZh, en: modelEn }),
    "dsh-asr: model settings dictionaries");
  ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
    name: "plugins.row.config", key: "@huliux/dsh-asr-plugin#dsh-asr", locale: MODEL_SETTINGS_NAMESPACE,
  }, ({ form, t, view }) => view === "summary" ? t("summary")
    : <ModelSettingsPage form={form} rpc={connection.rpc} t={t} />));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: "dsh-asr-recording",
    order: 100,
    label: "Recording assistant",
  }, () => <RecordingPanel
    currentSessionId={() => currentSessionId(ctx)}
    locale={ctx.locale}
    references={references}
    rpc={connection.rpc}
    translate={translate}
  />));
}
