import type { OpenTarget } from "@abacus-ai/contract/contract";

/** Let TanStack serialize params/search and add the platform's basepath. */
export const openTargetOptions = (target: OpenTarget) => {
  if (target.kind === "bot") {
    if (target.sessionId)
      return {
        to: "/bots/$botId/chats/$sessionId",
        params: { botId: target.botId, sessionId: target.sessionId },
      } as const;
    return { to: "/bots/$botId", params: { botId: target.botId } } as const;
  }
  // The notch's own switch lives on General.
  if (target.kind === "settings") return { to: "/settings/general" } as const;
  if (target.kind === "routine-run")
    return {
      to: "/routines/$routineId",
      params: { routineId: target.routineId },
      search: { run: target.sessionId },
    } as const;
  return {
    to: "/sessions/$sessionId",
    params: { sessionId: target.sessionId },
  } as const;
};
