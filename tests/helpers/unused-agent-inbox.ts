import type { Inbox } from "@deepseek-ai/dsh-agent";

export function unusedAgentInbox(): Inbox {
  const unexpected = (): never => { throw new Error("This fixture does not drive Agent input"); };
  return {
    nextTurn: [],
    nextStep: [],
    clear: unexpected,
    append: unexpected,
    prepend: unexpected,
    replace: unexpected,
    remove: unexpected,
    splice: unexpected,
  };
}
