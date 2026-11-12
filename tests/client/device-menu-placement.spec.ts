import { expect, it, vi } from "vitest";

vi.mock("@deepseek-ai/dsh-client-ui-primitives", () => ({
  Button: () => null, Tooltip: () => null, StateDot: () => null,
}));

import { opensBelow } from "../../src/client/RecordingPanelControls.js";

it("opens above the control when the panel floats near the bottom of the window", () => {
  expect(opensBelow(900)).toBe(false);
});

it("flips below the control when there is no room above it", () => {
  expect(opensBelow(120)).toBe(true);
  expect(opensBelow(259)).toBe(true);
  expect(opensBelow(260)).toBe(false);
  expect(opensBelow(120, 100)).toBe(false);
});
