import { connectorById } from "@abacus-ai/connectors/registry";
import {
  isMessagingPlatformConnected,
  type MessagingPlatformId,
} from "@abacus-ai/contract/messaging";
import { isPayingAbacusTier } from "@abacus-ai/contract/models";
import { canSignOutOfAbacus } from "@abacus-ai/contract/settings";
import { isCancelledError } from "@tanstack/react-query";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { OnboardingLocalModels } from "#platform/local-models";
import { createBotFromTemplate } from "#renderer/features/bots/data/bot-actions";
import { MessagingPlatformDialog } from "#renderer/features/library/messaging";
import { OnboardingStepPage } from "#renderer/features/onboarding";
import { completeOnboarding } from "#renderer/features/onboarding/actions";
import {
  enterStep,
  type OnboardingExit,
} from "#renderer/features/onboarding/actions";
import {
  releaseOnboardingConnect,
  connectOnboarding,
} from "#renderer/features/onboarding/connect";
import {
  firstBotTemplateId,
  noteConnectedChatApp,
  previewFirstBot,
} from "#renderer/features/onboarding/first-bot";
import {
  startFirstRunGmail,
  startWebsiteSignIn,
} from "#renderer/features/onboarding/first-run";
import {
  guardStep,
  onboardingExitTarget,
  type FlowFacts,
} from "#renderer/features/onboarding/machine";
import {
  onboardingStore,
  startSignIn,
  cancelSignIn,
} from "#renderer/features/onboarding/store";
import { startTour } from "#renderer/features/tour/store";
import {
  ONBOARDING_STEPS,
  type OnboardingStepId,
} from "#renderer/lib/navigation/areas";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
const OnboardingRoute = () => {
  const { t } = useTranslation();
  const step = Route.useParams().step as OnboardingStepId;
  const { facts } = Route.useLoaderData();
  const { transport, db, queryClient } = Route.useRouteContext();
  const [pairing, setPairing] = useState<{
    id: string;
    platform: MessagingPlatformId;
  } | null>(null);
  const router = useRouter();
  const navigate = useAppNavigate();
  const go = (step: OnboardingStepId) =>
    navigate({
      to: "/onboarding/$step",
      params: { step },
      replace: true,
      transition: "none",
    });
  const navigateStep = (target: OnboardingStepId) => {
    // The URL can change before the outgoing step and its key handler unmount.
    if (router.state.location.pathname !== `/onboarding/${step}`)
      return Promise.resolve();
    return go(target);
  };
  const entered = useRef<OnboardingStepId | null>(null);
  useEffect(() => {
    if (entered.current !== step) {
      entered.current = step;
      void enterStep(db, transport, step).catch((error) => {
        entered.current = null;
        console.warn("[onboarding] enter failed", error);
      });
    }
    return () => {
      if (step === "models") {
        void transport.client.auth.openRouter.cancel({}).catch(() => undefined);
        void cancelSignIn(transport).catch(() => undefined);
      }
      if (step === "connectors") releaseOnboardingConnect();
    };
  }, [db, transport, step]);
  const auth = (intent: "signup" | "signin") => {
    if (
      startSignIn(transport, intent, async (outcome) => {
        const attemptId = onboardingStore.state.signIn?.id;
        if (step === "models") {
          void queryClient.invalidateQueries();
          return;
        }
        if (outcome.ok) {
          const account = await transport.client.account.abacus({
            refresh: true,
          });
          if (onboardingStore.state.signIn?.id !== attemptId) return;
          // Optional connector consent must not hold up a completed sign-in.
          void startFirstRunGmail(
            transport,
            account?.google_sign_in === true
          ).catch(() => {});
          await queryClient.invalidateQueries();
          if (onboardingStore.state.signIn?.id !== attemptId) return;
          await go("connected");
        } else if (outcome.cancelled) await go("welcome");
      }) &&
      step !== "models"
    )
      void go("connect");
  };
  const finish = (exit: OnboardingExit, createDefaultBot = false) =>
    completeOnboarding(
      {
        db,
        transport,
        queryClient,
        navigate: async (exit) => {
          await navigate({
            ...onboardingExitTarget(exit),
            replace: true,
            transition: "none",
          });
          if (router.state.isLoading)
            await new Promise<void>((resolve) => {
              const stop = router.subscribe("onResolved", () => {
                stop();
                resolve();
              });
            });
        },
        resolveExit: async (exit) => {
          if (!createDefaultBot && exit.to !== "bot" && exit.to !== "bot-tour")
            return exit;
          try {
            const snapshot = await transport.client.db.bots.snapshot({});
            const existing = snapshot.rows[0];
            if (existing) {
              await transport.client.system.funnelStep({
                step: "first_bot_skipped",
                detail: "has_bots",
              });
              if (exit.to === "new-session") return exit;
              return exit.to === "bot" || exit.to === "bot-tour"
                ? {
                    ...exit,
                    botId: snapshot.rows.some((bot) => bot.id === exit.botId)
                      ? exit.botId
                      : existing.id,
                  }
                : { to: "bot", botId: existing.id };
            }
            // The bot the connected chat app makes obvious; main makes it
            // that app's home bot once onboarding completes.
            const templateId = firstBotTemplateId(
              onboardingStore.state.chatApp
            );
            const { bot } = await createBotFromTemplate(db, templateId, {
              name: t(`bots.templates.${templateId}.name`),
              // The house pays for the Chief of Staff's first inbox pass.
              ...(templateId === "chief-of-staff"
                ? { sponsoredFirstRun: true }
                : {}),
            });
            await transport.client.system.funnelStep({
              step: "first_bot_shown",
            });
            await transport.client.system.funnelStep({
              step: "first_bot_kept",
            });
            // Building straight away keeps the bot, and still opens the session.
            if (exit.to === "new-session") return exit;
            return exit.to === "bot" || exit.to === "bot-tour"
              ? { ...exit, botId: bot.id }
              : { to: "bot", botId: bot.id };
          } catch (error) {
            await transport.client.system.funnelStep({
              step: "first_bot_skipped",
              detail: "create_failed",
            });
            throw error;
          }
        },
        startTour: () =>
          startTour({
            onboarded: true,
          }),
      },
      exit
    );
  const create = async (id: string) => {
    const templateId = firstBotTemplateId(onboardingStore.state.chatApp);
    return previewFirstBot(
      id,
      t(`bots.templates.${templateId}.name`),
      templateId
    );
  };
  const automaticallySignIn = useEffectEvent(() => {
    if (onboardingStore.state.signIn?.status !== "pending") auth("signin");
  });
  useEffect(() => {
    // Nothing is known yet: no sign-in starts, nothing completes.
    if (facts.provisional) return;
    if (step === "welcome" && !facts.signedIn)
      void startWebsiteSignIn(transport, automaticallySignIn).catch(() => {});
    if (facts.signedIn && facts.googleSignIn)
      void startFirstRunGmail(transport, true).catch(() => {});
  }, [step, facts.provisional, facts.signedIn, facts.googleSignIn, transport]);
  const connect = async (id: string) => {
    const entry = connectorById(id);
    if (IS_ELECTRON && entry?.kind === "messaging") {
      setPairing({ id, platform: entry.platform });
      return;
    }
    return connectOnboarding(db, transport, id);
  };
  return (
    <>
      <OnboardingStepPage
        step={step}
        facts={facts}
        transport={transport}
        navigate={navigateStep}
        signIn={auth}
        cancelSignIn={() => cancelSignIn(transport)}
        complete={(exit, options) =>
          finish(exit, options?.keepFirstBot === true)
        }
        createFirstBot={create}
        connect={connect}
        localModel={
          <OnboardingLocalModels
            transport={transport}
            saved={() => queryClient.invalidateQueries()}
          />
        }
      />
      {pairing && step === "connectors" && (
        <MessagingPlatformDialog
          key={pairing.platform}
          platform={pairing.platform}
          onClose={async () => {
            setPairing(null);
            const snapshot = await transport.client.messaging.snapshot({});
            const platform = pairing.platform;
            if (
              (platform === "whatsapp" ||
                platform === "telegram" ||
                platform === "discord") &&
              isMessagingPlatformConnected(snapshot, platform)
            )
              noteConnectedChatApp(platform);
            await queryClient.invalidateQueries({
              queryKey: transport.orpc.connectors.statuses.queryKey({
                input: {},
              }),
            });
          }}
          finalFocus={() =>
            document.querySelector<HTMLElement>(
              `[data-connector="${pairing.id}"]`
            )
          }
        />
      )}
    </>
  );
};
/**
 * The facts a step decides on, from the host. Reads with the load's signal:
 * a navigation away cancels them, and they wait for the host as long as
 * the load does (never held as writes).
 */
const factsOf = async (
  context: import("#renderer/router").RouterContext,
  signal: AbortSignal
): Promise<FlowFacts> => {
  const [settings, account] = await Promise.all([
    context.transport.client.settings.get({}, { signal }),
    context.transport.client.account.abacus({}, { signal }),
  ]);
  return {
    signedIn: canSignOutOfAbacus(settings),
    payingTier: isPayingAbacusTier(account?.subscription_tier),
    googleSignIn: account?.google_sign_in === true,
    ownsBot: context.db.collections.bots.toArray.length > 0,
  };
};
/**
 * Warms a step's query without failing the load when it is cancelled. The
 * pending skeleton unmounts the outgoing step, whose observer may be the
 * query's last, and that cancels the fetch; the step's own query refetches.
 */
const warm = (load: Promise<unknown>) =>
  load.then(
    () => undefined,
    (error: unknown) => {
      if (!isCancelledError(error)) throw error;
    }
  );
/**
 * While onboarding renders provisionally (the browser's host is still
 * connecting, spec 09 D12) nothing is known: the step renders as asked,
 * acts on no fact and redirects nowhere. Once the host answers, the
 * parent's gate re-runs and this route's guard decides from fresh facts.
 */
const UNKNOWN_FACTS: FlowFacts = {
  signedIn: false,
  payingTier: false,
  ownsBot: false,
  provisional: true,
};
export const Route = createFileRoute("/_bare/onboarding/$step")({
  params: { parse: v.parser(v.object({ step: v.picklist(ONBOARDING_STEPS) })) },
  beforeLoad: async ({ context, params, abortController }) => {
    if (context.provisional) return;
    await context.db.collections.bots.preload();
    const facts = await factsOf(context, abortController.signal);
    const guarded = guardStep(
      params.step as OnboardingStepId,
      facts,
      onboardingStore.state
    );
    if (guarded !== params.step)
      throw redirect({
        to: "/onboarding/$step",
        params: { step: guarded },
        replace: true,
      });
  },
  loader: async ({ context, params, cause, abortController }) => {
    if (context.provisional) return { facts: UNKNOWN_FACTS };
    const { signal } = abortController;
    if (cause === "preload") return { facts: await factsOf(context, signal) };
    if (params.step === "connected")
      await context.transport.client.account.abacus(
        { refresh: true },
        { signal }
      );
    if (params.step === "models")
      await Promise.all([
        warm(
          context.queryClient.ensureQueryData(
            context.transport.orpc.settings.keys.listProviders.queryOptions({
              input: {},
            })
          )
        ),
        warm(
          context.queryClient.ensureQueryData(
            context.transport.orpc.models.list.queryOptions({ input: {} })
          )
        ),
      ]);
    // A local runtime is optional and may be down: warm it without holding the
    // step (the query's default retries back off for ~7s) and let the pane
    // present its unavailable state.
    if (params.step === "models")
      void context.queryClient.prefetchQuery({
        ...context.transport.orpc.localModels.state.queryOptions({ input: {} }),
        retry: false,
      });
    // A network read: the step shows at once, its tiles waiting on it.
    if (params.step === "connectors")
      void warm(
        context.queryClient.ensureQueryData(
          context.transport.orpc.connectors.statuses.queryOptions({ input: {} })
        )
      ).catch(() => undefined);
    if (params.step === "first-bot")
      await context.db.collections.routines.preload();
    return { facts: await factsOf(context, signal) };
  },
  component: OnboardingRoute,
});
