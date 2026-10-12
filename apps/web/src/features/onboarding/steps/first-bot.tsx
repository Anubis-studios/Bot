/** Final setup opens the chosen product destination when completion succeeds. */
import type { BotRow } from "@abacus-ai/contract/contract";
import { Code2 } from "lucide-react";
import type { Ref } from "react";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { Spinner } from "#renderer/components/spinner";
import { resolveLook } from "#renderer/lib/bots/avatar";

import type { FirstBotState } from "../first-bot";
import type { StepContext } from "./context";
import { StepBody, StepButton, StepLink, StepLinks, StepTitle } from "./kit";

export const FirstBotStep = ({
  ctx,
  first,
  bot,
  present,
  heading,
}: {
  ctx: StepContext;
  first: FirstBotState;
  bot: BotRow | null;
  /** The bot is still in the collection (or is a gallery preview). */
  present: boolean;
  heading: Ref<HTMLHeadingElement>;
}) => {
  const { t, busy, props, perform } = ctx;
  const funnel = (step: "first_bot_kept" | "first_build_chosen") =>
    props.transport.client.system.funnelStep({ step });
  return (
    <>
      <StepTitle ref={heading}>
        {t("onboarding.pages.first-bot.title")}
      </StepTitle>
      {bot && (
        <StepBody className="mt-1.5 max-w-[520px]">
          {t("onboarding.pages.first-bot.body", { name: bot.name })}
        </StepBody>
      )}
      {first.state === "pending" && (
        <div className="mt-6">
          <Spinner />
        </div>
      )}
      {first.state === "removed" && (
        <>
          <StepBody className="mt-6">{t("onboarding.pages.removed")}</StepBody>
          <div className="mt-4">
            <StepButton
              disabled={busy}
              onClick={() =>
                void perform(() => props.complete({ to: "new-bot" }))
              }
            >
              {t("onboarding.connectorsContinue")}
            </StepButton>
          </div>
        </>
      )}
      {bot && (
        <div className="mt-6 flex w-full max-w-[520px] flex-col gap-2.5">
          <div className="onboarding-card flex items-center gap-3 rounded-[14px] py-3 pr-3 pl-4">
            <BotAvatar
              animate
              look={resolveLook({
                name: bot.name,
                avatarShape: bot.avatarShape,
                avatarColor: bot.avatarColor,
              })}
              size={40}
              mood="wink"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {present ? bot.name : t("onboarding.pages.removed")}
              </span>
              <span className="onboarding-quiet block">
                {t(
                  first.state === "ready" && first.result.checkInRoutineId
                    ? "onboarding.pages.checkIn"
                    : "onboarding.pages.noCheckIn"
                )}
              </span>
            </span>
            <StepButton
              className="h-9 px-4"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await funnel("first_bot_kept");
                  await props.complete({ to: "bot", botId: bot.id });
                })
              }
            >
              {t("onboarding.pages.hello")}
            </StepButton>
          </div>
          <div className="onboarding-card flex items-center gap-3 rounded-[14px] py-3 pr-3 pl-4">
            <span className="bg-primary/10 flex size-10 shrink-0 items-center justify-center rounded-xl">
              <Code2 aria-hidden className="text-primary size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">
                {t("onboarding.pages.buildTitle")}
              </span>
              <span className="onboarding-quiet block">
                {t("onboarding.pages.buildBody")}
              </span>
            </span>
            <StepButton
              className="h-9 px-4"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await funnel("first_build_chosen");
                  await props.complete(
                    { to: "new-session" },
                    { keepFirstBot: true }
                  );
                })
              }
            >
              {t("onboarding.pages.buildCta")}
            </StepButton>
          </div>
          <StepLinks className="mt-3 justify-center">
            {[
              <StepLink
                key="tour"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await funnel("first_bot_kept");
                    await props.complete({ to: "bot-tour", botId: bot.id });
                  })
                }
              >
                {t("tour.replay")}
              </StepLink>,
              <StepLink
                key="edit"
                disabled={busy}
                onClick={() =>
                  void perform(() =>
                    props.complete({ to: "bot", botId: bot.id, edit: true })
                  )
                }
              >
                {t("onboarding.pages.editBot", { name: bot.name })}
              </StepLink>,
            ]}
          </StepLinks>
        </div>
      )}
      {!bot && first.state !== "pending" && (
        <div className="mt-3">
          <StepLink
            disabled={busy}
            onClick={() =>
              void perform(() => props.complete({ to: "new-session" }))
            }
          >
            {t("onboarding.pages.newSession")}
          </StepLink>
        </div>
      )}
    </>
  );
};
