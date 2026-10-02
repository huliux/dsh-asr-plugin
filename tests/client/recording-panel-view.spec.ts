import { isValidElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";

vi.mock("@deepseek-ai/dsh-client-ui-primitives", () => ({
  Button: () => null, Tooltip: () => null, StateDot: () => null,
  IconWarningOutlineRegular: () => null, IconRefreshOutlineRegular: () => null,
}));
vi.mock("../../src/client/use-recording-panel-layout.js", () => ({
  useRecordingPanelLayout: () => ({ expanded: true, style: {}, move: {}, resize: {},
    toggle: vi.fn(), reset: vi.fn() }),
}));

import { RecordingPanelView } from "../../src/client/RecordingPanelView.js";
import { en, zh } from "../../src/client/meeting-reference-locales.js";

function alertText(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(alertText).find(value => value !== undefined);
  if (!isValidElement<{ role?: string; children?: ReactNode }>(node)) return undefined;
  return node.props.role === "alert" ? node.props.children : alertText(node.props.children);
}

it.each([zh, en])("renders actionable no-signal copy without asserting permission denial", locale => {
  const result = RecordingPanelView({ hasRecordingHistory: false, failure: "SYSTEM_AUDIO_NO_SIGNAL",
    join: vi.fn(), pending: false, pendingAction: null, preview: [], run: vi.fn(), view: null,
    translate: key => locale[key] });
  expect(alertText(result)).not.toBe("SYSTEM_AUDIO_NO_SIGNAL");
  expect(alertText(result)).toContain(locale === zh ? "播放" : "playback");
  expect(alertText(result)).toContain(locale === zh ? "系统设置" : "System Settings");
});
