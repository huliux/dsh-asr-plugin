import { createElement, isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as Array<() => (() => void)> }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useEffect: (effect: () => (() => void)) => hooks.effects.push(effect),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.cells)) hooks.cells[index] = initial;
    return [hooks.cells[index], (value: unknown) => {
      hooks.cells[index] = typeof value === "function" ? value(hooks.cells[index]) : value;
    }];
  },
}));
vi.mock("@deepseek-ai/dsh-client-ui-primitives", () => ({
  Button: (props: object) => createElement("button", props),
  Input: (props: object) => createElement("input", props),
  DisclosureRow: ({ children, onToggle }: { children: ReactNode; onToggle: () => void }) =>
    createElement("div", {}, createElement("button", { onClick: onToggle }, "disclosure"), children),
  StateDot: () => null, Tag: ({ children }: { children: ReactNode }) => children,
  IconInfoOutlineRegular: () => null,
}));
import { ModelDownloadSettings } from "../../src/client/ModelDownloadSettings.js";

interface NodeProps { children?: ReactNode; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void; }
function flatten(node: ReactNode): Array<{ type: unknown; props: NodeProps }> {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isValidElement<NodeProps>(node)) return [];
  if (typeof node.type === "function") return flatten((node.type as (props: NodeProps) => ReactNode)(node.props));
  return [{ type: node.type, props: node.props }, ...flatten(node.props.children)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (typeof node === "string") return node;
  return isValidElement<NodeProps>(node) ? text(node.props.children) : "";
}
function fixture(rpc: ClientConnectionRpc = {} as ClientConnectionRpc) {
  const mutate = vi.fn(async () => true);
  const form = { state: { writable: true, status: "ready", revision: 1, value: {} }, mutate } as unknown as ConfigPageForm;
  const render = () => {
    hooks.cursor = 0;
    return flatten(createElement(ModelDownloadSettings, { form, rpc,
      t: key => key, models: null, onInstalled: vi.fn() }));
  };
  const edit = (value: string) => render().find(node => node.type === "input")!.props.onChange!({ target: { value } });
  const save = async () => {
    render().find(node => node.type === "button" && text(node.props.children) === "save")!.props.onClick!();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { render, edit, save, mutate, visibleText: () => render().map(node => text(node.props.children)).join(" ") };
}
beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; });
it.each(["", "http://127.0.0.1:7890"])("clears obsolete validation feedback when proxy input changes to %s", async value => {
  const page = fixture();
  page.edit("not-a-proxy"); await page.save();
  expect(page.visibleText()).toContain("proxyInvalid");
  expect(page.mutate).not.toHaveBeenCalled();
  page.edit(value);
  expect(page.visibleText()).not.toContain("proxyInvalid");
});
it("retains a download failure while the proxy field is edited", () => {
  const page = fixture(); page.render();
  hooks.cells[3] = "downloadFailed";
  page.edit("http://127.0.0.1:7890");
  expect(page.visibleText()).toContain("downloadFailed");
});

it("removes a recovered polling failure without erasing proxy validation", async () => {
  vi.useFakeTimers();
  const call = vi.fn().mockRejectedValueOnce(new Error("network unavailable")).mockResolvedValue({ ok: true, value: {
    phase: "idle", pack: null, jobId: null, errorCode: null, downloadedBytes: 0, totalBytes: 0,
  } });
  const page = fixture({ call } as ClientConnectionRpc); page.render();
  const cleanup = hooks.effects[0]!();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(page.visibleText()).toContain("downloadFailed");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(page.visibleText()).not.toContain("downloadFailed");
    page.edit("bad-proxy"); await page.save();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(page.visibleText()).toContain("proxyInvalid");
  } finally { cleanup(); vi.useRealTimers(); }
});
