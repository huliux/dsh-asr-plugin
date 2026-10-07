import { useCallback, useSyncExternalStore } from "react";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
import { ModelSettingsPage } from "./ModelSettingsPage.js";
import type { ModelSettingsTranslate } from "./model-settings-locales.js";

type Props = {
  source: ConfigForm<Record<string, unknown>>;
  rpc: ClientConnectionRpc;
  t: ModelSettingsTranslate;
};

export function ModelSettingsBundle({ source, rpc, t }: Props) {
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source]);
  const getSnapshot = useCallback(() => source.getSnapshot(), [source]);
  const state = useSyncExternalStore(subscribe, getSnapshot);
  return <ModelSettingsPage form={{ state, mutate: (ops, revision) => source.mutate(ops, revision) }} rpc={rpc} t={t} />;
}
