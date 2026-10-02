import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";

export function currentSessionId(ctx: Context): string | undefined {
  return Object.values(ctx.sessions.list.getSnapshot().byId)
    .find((session) => (session.retainedBy.mainView ?? 0) > 0)?.id;
}
