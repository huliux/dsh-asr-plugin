import { expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(),
  useState: () => [true, vi.fn()], useEffect: vi.fn(), useCallback: (value: unknown) => value }));
vi.mock("@deepseek-ai/dsh-client-ui-primitives", () => ({
  Button: () => null, CodeBlock: ({ code }: {code: string}) => code,
  DisclosureRow: ({children}: {children: ReactNode}) => children,
  StateDot: () => null, IconInfoOutlineRegular: () => null, IconRefreshOutlineRegular: () => null,
}));
import { ModelInstructions } from "../../src/client/ModelSettingsPage.js";

import { modelZh } from "../../src/client/model-settings-locales.js";
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (typeof node === "string") return node;
  if (!isValidElement<{children?: ReactNode}>(node)) return "";
  if (typeof node.type === "function") return text((node.type as (props: unknown) => ReactNode)(node.props));
  return text(node.props.children);
}
it("does not expose the configured personal directory in developer command examples", () => {
  const status = { dataDirectory: "/Users/private-name/.dsh/private-data", base: {state:"ready",issues:[]},
    punctuation:{state:"missing",issues:[]}, native:{state:"ready",issues:[]}, mode:"base",
    preference:null, inheritedLegacy:false, selectedReady:true } as const;
  const rendered = text(ModelInstructions({ status, t: key => modelZh[key] }));
  expect(rendered).not.toContain("/Users/private-name");
  expect(rendered).toContain("--data-dir /path/to/plugin-data");
  expect(rendered).toContain("--profile web exec");
  expect(rendered).not.toContain("PROFILE");
  expect(rendered).toContain("桌面版请在设置页下载和诊断");
});
