import { expect, it } from "vitest";

import {
  reduceAutoReference,
  type AutoReferenceRuntimeState,
} from "../../src/client/meeting-reference-auto-state.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";

function present(): AutoReferenceRuntimeState {
  return {
    initialized: true,
    inputPhase: "plain",
    meetingId: MEETING_ID,
    mode: "auto",
    present: true,
  };
}

it("刷新恢复 auto 状态时补回缺失标签，普通删除则进入 suppressed", () => {
  const restored = reduceAutoReference(null, {
    type: "restore",
    inputPhase: "plain",
    meetingId: MEETING_ID,
    mode: "auto",
    present: false,
  });
  expect(restored).toMatchObject({ effect: "insert", state: { mode: "auto" } });

  const deleted = reduceAutoReference(present(), {
    type: "observe",
    inputPhase: "plain",
    present: false,
    selfMutation: false,
  });
  expect(deleted).toMatchObject({ effect: "none", state: { mode: "suppressed" } });
});

it("成功发送清空标签后保持 auto 并请求补回", () => {
  const submitting = reduceAutoReference(present(), {
    type: "observe",
    inputPhase: "submitting",
    present: true,
    selfMutation: false,
  });
  const cleared = reduceAutoReference(submitting.state, {
    type: "observe",
    inputPhase: "plain",
    present: false,
    selfMutation: false,
  });

  expect(cleared).toMatchObject({ effect: "insert", state: { mode: "auto" } });
});

it("@加入恢复 suppression，而 Meeting 终态只停止自动策略", () => {
  const suppressed = { ...present(), mode: "suppressed" as const, present: false };
  const joined = reduceAutoReference(suppressed, { type: "join", meetingId: MEETING_ID });
  expect(joined).toMatchObject({ effect: "insert", state: { mode: "auto" } });

  expect(reduceAutoReference(joined.state, {
    type: "retire",
    meetingId: MEETING_ID,
  })).toEqual({ effect: "none", state: null });
});
