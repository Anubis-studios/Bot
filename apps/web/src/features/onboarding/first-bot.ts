import type { HomeChannel } from "@abacus-ai/contract/bots";
import type { BotRow } from "@abacus-ai/contract/contract";
import { Store } from "@tanstack/react-store";

import { isRpcError } from "#renderer/data/query-client";
import { resolveLook } from "#renderer/lib/bots/avatar";
import {
  BOT_TEMPLATES,
  TEMPLATE_FOR_CONNECTOR,
} from "#renderer/lib/bots/templates";

import { onboardingStore } from "./store";
export type FirstBotResult = {
  bot: BotRow;
  checkInRoutineId: string | null;
  preview?: boolean;
};
/** Onboarding's first bot: the agent of the chat app connected last, else the Chief of Staff. */
export const firstBotTemplateId = (chatApp?: HomeChannel | null): string => {
  const agent =
    chatApp != null ? TEMPLATE_FOR_CONNECTOR[`messaging-${chatApp}`] : null;
  return agent != null && BOT_TEMPLATES.some((row) => row.id === agent)
    ? agent
    : "chief-of-staff";
};
/** A chat app just connected in onboarding: it picks the first bot, so a stale preview goes. */
export const noteConnectedChatApp = (chatApp: HomeChannel): void => {
  onboardingStore.setState((state) => ({ ...state, chatApp }));
  const first = firstBotStore.state;
  if (first.state === "ready" && first.result.preview === true)
    firstBotStore.setState(() => ({ state: "idle" }));
};
/** A historical first-bot step previews the role; persistence waits for completion. */
export const previewFirstBot = (
  id: string,
  name: string,
  templateId = "chief-of-staff"
): FirstBotResult => {
  const template = BOT_TEMPLATES.find((row) => row.id === templateId)!;
  const look = resolveLook({
    name,
    avatarShape: template.avatarShape,
    avatarColor: template.avatarColor,
  });
  return {
    preview: true,
    checkInRoutineId: null,
    bot: {
      id,
      name,
      title: template.title,
      persona: template.persona,
      description: template.mission,
      avatarShape: look.shape,
      avatarColor: look.color,
      model: null,
      channel: null,
      ...(template.homeChannel != null
        ? { homeChannel: template.homeChannel }
        : {}),
      templateId: template.id,
      sessionId: null,
      workspaceId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
};
export type FirstBotState =
  | { state: "idle" }
  | { state: "pending"; promise: Promise<FirstBotResult | null> }
  | { state: "ready"; result: FirstBotResult }
  | { state: "skipped"; reason: "has_bots" | "no_template" | "create_failed" }
  | { state: "removed" };
export const firstBotStore = new Store<FirstBotState>({ state: "idle" });
export const ensureFirstBot = (
  ownsBot: boolean,
  create: (id: string) => Promise<FirstBotResult>
): void => {
  if (firstBotStore.state.state !== "idle") return;
  if (ownsBot) {
    firstBotStore.setState(() => ({ state: "skipped", reason: "has_bots" }));
    return;
  }
  const id = `bot-${crypto.randomUUID()}`;
  onboardingStore.setState((state) => ({ ...state, createdBotId: id }));
  // Store the pending state before invoking a mutation, including synchronous callbacks.
  let begin!: () => void;
  const promise = new Promise<FirstBotResult | null>((resolve) => {
    begin = () => {
      void create(id)
        .then((result) => {
          firstBotStore.setState(() => ({ state: "ready", result }));
          resolve(result);
        })
        .catch((error) => {
          firstBotStore.setState(() => ({
            state: "skipped",
            reason:
              isRpcError(error) && error.code === "NOT_FOUND"
                ? "no_template"
                : "create_failed",
          }));
          resolve(null);
        });
    };
  });
  firstBotStore.setState(() => ({ state: "pending", promise }));
  begin();
};
