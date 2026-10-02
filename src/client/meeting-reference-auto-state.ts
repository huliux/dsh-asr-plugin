export type AutoReferenceMode = "auto" | "suppressed";
export type MeetingInputPhase = "plain" | "adjudicating" | "claimed" | "submitting";

export interface AutoReferenceRuntimeState {
  readonly initialized: boolean;
  readonly inputPhase: MeetingInputPhase;
  readonly meetingId: string;
  readonly mode: AutoReferenceMode;
  readonly present: boolean;
}

export type AutoReferenceEvent =
  | {
    readonly type: "restore" | "activate";
    readonly inputPhase: MeetingInputPhase;
    readonly meetingId: string;
    readonly mode?: AutoReferenceMode;
    readonly present: boolean;
  }
  | { readonly type: "join"; readonly meetingId: string }
  | {
    readonly type: "observe";
    readonly inputPhase: MeetingInputPhase;
    readonly present: boolean;
    readonly selfMutation: boolean;
  }
  | { readonly type: "retire"; readonly meetingId: string };

export interface AutoReferenceReduction {
  readonly effect: "none" | "insert";
  readonly state: AutoReferenceRuntimeState | null;
}

function begin(event: Extract<AutoReferenceEvent, { type: "restore" | "activate" }>): AutoReferenceReduction {
  const mode = event.mode ?? "auto";
  return {
    effect: mode === "auto" && !event.present ? "insert" : "none",
    state: {
      initialized: true,
      inputPhase: event.inputPhase,
      meetingId: event.meetingId,
      mode,
      present: event.present,
    },
  };
}

function observe(
  state: AutoReferenceRuntimeState,
  event: Extract<AutoReferenceEvent, { type: "observe" }>,
): AutoReferenceReduction {
  const next = { ...state, inputPhase: event.inputPhase, present: event.present };
  if (state.mode === "suppressed" || event.selfMutation || !state.present || event.present) {
    return { effect: "none", state: next };
  }
  if (state.inputPhase === "submitting" && event.inputPhase === "plain") {
    return { effect: "insert", state: next };
  }
  return { effect: "none", state: { ...next, mode: "suppressed" } };
}

export function reduceAutoReference(
  state: AutoReferenceRuntimeState | null,
  event: AutoReferenceEvent,
): AutoReferenceReduction {
  if (event.type === "restore" || event.type === "activate") return begin(event);
  if (event.type === "retire") {
    return event.meetingId === state?.meetingId
      ? { effect: "none", state: null }
      : { effect: "none", state };
  }
  if (event.type === "join") {
    const next = state?.meetingId === event.meetingId
      ? { ...state, mode: "auto" as const }
      : {
        initialized: true,
        inputPhase: "plain" as const,
        meetingId: event.meetingId,
        mode: "auto" as const,
        present: false,
      };
    return { effect: next.present ? "none" : "insert", state: next };
  }
  if (event.type === "observe") {
    return state === null ? { effect: "none", state } : observe(state, event);
  }
  return { effect: "none", state };
}
