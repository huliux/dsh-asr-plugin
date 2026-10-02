import type {
  InputTriggerCandidate,
  InputTriggerSource,
} from "@deepseek-ai/dsh-client-ui-input-trigger/client";

import type {
  MeetingReferenceRpcCandidate,
  MeetingReferenceRpcPhase,
} from "../recording/rpc-contract.js";
import type { RecordingRpcClient } from "./recording-rpc-client.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const URI_PREFIX = "](dsh-meeting:";
const ESCAPED_LABEL_CHARACTERS = new Set(["\\", "[", "]", "(", ")"]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export interface MeetingReferenceIdentity {
  readonly meetingId: string;
  readonly label: string;
}

export type MeetingReferenceTranslationKey =
  | "auto.current"
  | "section.meetings"
  | `phase.${MeetingReferenceRpcPhase}`
  | "time.duration"
  | "time.elapsed";

type TranslateMeetingReference = (
  key: MeetingReferenceTranslationKey,
  params?: Readonly<Record<string, string>>,
) => string;

interface MeetingReferenceSourceOptions {
  readonly client: RecordingRpcClient;
  readonly hasReference: (sessionId: string, meetingId: string) => boolean;
  readonly locale: () => string;
  readonly translate: TranslateMeetingReference;
}

function invalidReference(): never {
  throw new Error("INVALID_MEETING_REFERENCE");
}

function validateIdentity(identity: MeetingReferenceIdentity): void {
  if (!UUID_PATTERN.test(identity.meetingId) || identity.label.length < 1
    || identity.label.length > 255 || CONTROL_CHARACTER.test(identity.label)) invalidReference();
}

function escapeLabel(label: string): string {
  let escaped = "";
  for (const character of label) {
    escaped += ESCAPED_LABEL_CHARACTERS.has(character) ? `\\${character}` : character;
  }
  return escaped;
}

function unescapeLabel(value: string): string {
  let label = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (CONTROL_CHARACTER.test(character)) invalidReference();
    if (character !== "\\") {
      if (ESCAPED_LABEL_CHARACTERS.has(character)) invalidReference();
      label += character;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined || !ESCAPED_LABEL_CHARACTERS.has(escaped)) invalidReference();
    label += escaped;
    index += 1;
  }
  return label;
}

export function formatMeetingReference(identity: MeetingReferenceIdentity): string {
  validateIdentity(identity);
  return `@[${escapeLabel(identity.label)}](dsh-meeting:${identity.meetingId})`;
}

export function parseMeetingReference(mention: string): MeetingReferenceIdentity {
  const marker = mention.lastIndexOf(URI_PREFIX);
  if (!mention.startsWith("@[") || marker < 2 || !mention.endsWith(")")) invalidReference();
  const identity = {
    meetingId: mention.slice(marker + URI_PREFIX.length, -1),
    label: unescapeLabel(mention.slice(2, marker)),
  };
  validateIdentity(identity);
  if (formatMeetingReference(identity) !== mention) invalidReference();
  return identity;
}

function parseCandidateValue(value: string | undefined): MeetingReferenceIdentity | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || typeof record.meetingId !== "string"
      || typeof record.label !== "string") return null;
    const identity = { meetingId: record.meetingId, label: record.label };
    formatMeetingReference(identity);
    return identity;
  } catch {
    return null;
  }
}

export function durationClock(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}:${seconds}`;
  return `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, "0")}:${seconds}`;
}

function candidateDescription(
  candidate: MeetingReferenceRpcCandidate,
  locale: string,
  translate: TranslateMeetingReference,
): string {
  const timestamp = candidate.started_at ?? candidate.created_at;
  const time = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(timestamp));
  const elapsed = candidate.recording_elapsed_ms === null ? null
    : translate("time.elapsed", { value: durationClock(candidate.recording_elapsed_ms) });
  const duration = candidate.duration_ms === null ? null
    : translate("time.duration", { value: durationClock(candidate.duration_ms) });
  return [translate(`phase.${candidate.phase}`), time, elapsed ?? duration]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function sourceCandidate(
  candidate: MeetingReferenceRpcCandidate,
  locale: string,
  translate: TranslateMeetingReference,
): InputTriggerCandidate {
  return {
    name: candidate.label,
    description: candidateDescription(candidate, locale, translate),
    section: translate("section.meetings"),
    value: JSON.stringify({ meetingId: candidate.meeting_id, label: candidate.label }),
  };
}

function pickReference(
  options: MeetingReferenceSourceOptions,
  candidate: InputTriggerCandidate,
  sessionId: string,
) {
  const identity = parseCandidateValue(candidate.value);
  if (identity === null) return undefined;
  if (options.hasReference(sessionId, identity.meetingId)) return { text: "" } as const;
  const mention = formatMeetingReference(identity);
  return {
    insert: {
      source: "meeting-reference",
      ref: mention,
      label: identity.label,
      clipboardText: mention,
    },
  } as const;
}

function referenceCodec(options: MeetingReferenceSourceOptions): NonNullable<InputTriggerSource["codec"]> {
  return {
    clipboardText(ref) {
      parseMeetingReference(ref);
      return ref;
    },
    async serialize(ref, signal) {
      const identity = parseMeetingReference(ref);
      const resolved = await options.client.resolveMeetingReference({
        locale: options.locale(),
        meeting_id: identity.meetingId,
      }, signal);
      if (resolved.meeting_id !== identity.meetingId) invalidReference();
      return ref;
    },
  };
}

export function createMeetingReferenceSource(options: MeetingReferenceSourceOptions): InputTriggerSource {
  return {
    trigger: "@",
    name: "meeting-reference",
    order: 1,
    showGroupTitle: false,
    async candidates(session, request) {
      const locale = options.locale();
      const candidates = await options.client.referenceCandidates({
        session_id: session.sessionId,
        locale,
        ...(request.query.trim() === "" ? {} : { query: request.query }),
      }, request.signal);
      if (request.signal.aborted) return [];
      return candidates.map((candidate) => sourceCandidate(candidate, locale, options.translate));
    },
    onPick({ candidate, session }) {
      return pickReference(options, candidate, session.sessionId);
    },
    codec: referenceCodec(options),
  };
}
