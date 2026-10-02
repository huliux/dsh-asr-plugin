import { expect, it, vi } from "vitest";

import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { InputTriggerSource } from "@deepseek-ai/dsh-client-ui-input-trigger/client";

vi.mock("@deepseek-ai/dsh-client-ui-primitives", () => ({ Button: () => null, Switch: () => null, SettingsForm: () => null }));

import { apply, inject } from "../../src/client/index.js";

it("注册 DSH 原生 Meeting @ source、locale 与既有录音浮层", () => {
  let source: InputTriggerSource | undefined;
  const registerSource = vi.fn((value: InputTriggerSource) => {
    source = value;
    return vi.fn();
  });
  const registerLocale = vi.fn(() => vi.fn());
  const registerSlot = vi.fn(() => vi.fn());
  const connection = { rpc: { call: vi.fn() } };
  const meetingId = "11111111-1111-4111-8111-111111111111";
  const mention = `@[产品周会](dsh-meeting:${meetingId})`;
  const scope = {};
  const sessionList = {
    byId: { "session-1": { id: "session-1", retainedBy: { mainView: 1 } } },
    current: "session-1",
    ids: ["session-1"],
    phase: "ready",
  };
  const ctx = {
    get: vi.fn((name: string) => name === "connection" ? connection : undefined),
    effect: vi.fn((factory: () => unknown) => factory()),
    inputTriggers: { registerSource },
    conversation: {
      input: {
        for: vi.fn(() => ({
          state: { getSnapshot: () => ({ occurrences: [{ source: "meeting-reference", ref: mention }] }) },
        })),
      },
    },
    locale: {
      bind: vi.fn(() => (key: string) => key),
      getLocale: vi.fn(() => ({ active: "zh" })),
      getSnapshot: vi.fn(() => ({ active: "zh", locales: [], revision: 0 })),
      register: registerLocale,
      subscribe: vi.fn(() => vi.fn()),
    },
    slots: {
      inject: vi.fn((_name: string, factory: () => unknown) => factory()),
      register: registerSlot,
    },
    sessions: {
      list: { getSnapshot: () => sessionList, subscribe: () => vi.fn() },
      scope: vi.fn(() => scope),
    },
    workspaces: { list: { getSnapshot: () => ({ recentWorkspaceId: undefined }) } },
  } as unknown as ClientContext;

  apply(ctx);

  expect(inject).toEqual([
    "slots", "connection", "inputTriggers", "locale", "sessions", "uiWorkspace", "conversation",
  ]);
  expect(registerLocale).toHaveBeenCalledTimes(2);
  expect(registerSource).toHaveBeenCalledOnce();
  expect(source).toMatchObject({ trigger: "@", name: "meeting-reference" });
  expect(registerSlot).toHaveBeenCalledTimes(2);
  expect(source?.onPick({
    candidate: { name: "产品周会", value: JSON.stringify({ meetingId, label: "产品周会" }) },
    session: { sessionId: "session-1" as never },
    position: "inline",
    via: "menu",
    action: "pick",
    span: { start: 0, end: 2, draftRev: 1 },
  })).toEqual({ text: "" });
});
