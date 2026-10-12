/**
 * `offer_session`'s card in a bot's chat: a task the bot hands to a session
 * (a folder, files, a preview). Open session starts a new session with the
 * task in its message box, for the user to read and send.
 */
import { parsePartialJSON } from "@tanstack/ai-client";
import type { ToolProps } from "@tanstack/ai-react/ui";
import { Code2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

import { toolInput } from "./normalize";

/** Prefixed with its MCP server's name (`agent-tools_offer_session`): matched by suffix. */
export const isSessionOfferTool = (name: string): boolean =>
  name === "offer_session" || name.endsWith("_offer_session");

/** Calls already counted as shown, so a re-render or a scroll back counts nothing. */
const shown = new Set<string>();

export const SessionOfferCard = ({ part }: ToolProps<unknown>) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const navigate = useAppNavigate();
  const [dismissed, setDismissed] = useState(false);
  const input = toolInput(part, parsePartialJSON);
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const ready = part.input != null && prompt.length > 0;
  useEffect(() => {
    if (!ready || shown.has(part.id)) return;
    shown.add(part.id);
    void transport.client.system
      .funnelStep({ step: "session_offer_shown" })
      .catch(() => undefined);
  }, [ready, part.id, transport]);
  if (!ready || dismissed) return null;
  return (
    <div
      data-slot="session-offer"
      className="bg-card my-2 flex w-full max-w-[520px] flex-col gap-2 rounded-xl border p-3"
    >
      <div className="flex items-center gap-2">
        <Code2 aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <span className="text-sm font-medium">
          {t("bots.chat.sessionOfferHeading")}
        </span>
      </div>
      {title.length > 0 && (
        <p className="text-muted-foreground text-xs leading-4">{title}</p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => {
            void transport.client.system
              .funnelStep({ step: "session_offer_opened" })
              .catch(() => undefined);
            void navigate({
              to: "/sessions/new",
              search: { prompt, offer: part.id },
              transition: "nav-forward",
            });
          }}
        >
          {t("bots.chat.sessionOfferOpen")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
          {t("bots.chat.sessionOfferDismiss")}
        </Button>
      </div>
    </div>
  );
};
