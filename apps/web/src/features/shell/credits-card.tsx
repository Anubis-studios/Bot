import { Sparkles } from "lucide-react";
import { AnimatePresence, motion, animate } from "motion/react";
import { useEffect, useLayoutEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { usePrefs } from "#renderer/data/db/prefs";
import { useHasContextualUpsell } from "#renderer/lib/contextual-upsell";
import { creditsTier, upgradePitch } from "#renderer/lib/credits";
import {
  durations,
  easings,
  offsets,
  springs,
  reducedTransition,
  useMotionPreference,
} from "#renderer/lib/motion";
import { openUpgrade } from "#renderer/lib/upgrade";
import { useAppContext } from "#renderer/lib/use-app-context";
import { useCreditsAccount } from "#renderer/lib/use-credits-account";
import { useNow } from "#renderer/lib/use-now";
import { Button } from "#renderer/ui/button";

import { PromoCharacter } from "./promo-character";
import { usePromoHost, consumePromoRect } from "./promo-host";
import { promoAccountKey, promoState } from "./promo-state";

/** One portal, shown only inside the sidebar (pinned or peeked): a collapsed sidebar hides it. */
export const UpgradePromo = () => {
  const { transport } = useAppContext();
  const host = usePromoHost();
  const snapshot = useRef<DOMRect | null>(null);
  const [target] = useState(() => {
    const element = document.createElement("div");
    element.dataset.slot = "promo-portal";
    return element;
  });
  const { t, i18n } = useTranslation();
  const prefs = usePrefs();
  const now = useNow();
  const preference = useMotionPreference();
  useLayoutEffect(() => {
    const previous = snapshot.current
      ? snapshot.current
      : (consumePromoRect() ?? snapshot.current);
    if (!host) {
      target.remove();
      return;
    }
    target.setAttribute("style", "pointer-events:none");
    host.element.appendChild(target);
    const next = target.firstElementChild?.getBoundingClientRect();
    const controls =
      previous && next && preference !== "reduced"
        ? animate(
            target,
            {
              x: [previous.left - next.left, 0],
              y: [previous.top - next.top, 0],
            },
            {
              ...springs.panel,
              onComplete: () => {
                snapshot.current =
                  target.firstElementChild?.getBoundingClientRect() ?? null;
              },
            }
          )
        : null;
    snapshot.current = next ?? null;
    return () => controls?.stop();
  }, [host, target, preference]);
  useEffect(() => () => target.remove(), [target]);
  const account = useCreditsAccount();
  const key = promoAccountKey(account.data);
  const contextualUpsell = useHasContextualUpsell();
  const state = contextualUpsell
    ? null
    : promoState(account.data, prefs.creditsExhaustedAt, now);
  const [excited, setExcited] = useState(false);
  const tier = creditsTier(account.data);
  const pitch = upgradePitch(account.data);
  const remaining =
    account.data?.credits_granted != null && account.data.credits_used != null
      ? Math.max(0, account.data.credits_granted - account.data.credits_used)
      : null;
  if (tier !== "free" || contextualUpsell || !host)
    return createPortal(null, target);
  return createPortal(
    <AnimatePresence>
      {state ? (
        <motion.aside
          key={key}
          data-slot="upgrade-promo"
          aria-label={t("creditsCard.upsellTitle")}
          className="bg-background pointer-events-auto relative isolate w-full overflow-hidden rounded-(--pane-radius) border p-3"
          initial={{
            opacity: 0,
            y: preference === "reduced" ? 0 : offsets.drill,
          }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: preference === "reduced" ? 0 : offsets.drill }}
          transition={
            preference === "reduced"
              ? reducedTransition
              : { duration: durations.crossFade / 1000, ease: easings.standard }
          }
        >
          <div className="phone-glow pointer-events-none -z-10" aria-hidden />
          <div className="flex items-center gap-3">
            <PromoCharacter
              remaining={remaining}
              total={account.data?.credits_granted ?? null}
              excited={excited}
              upgraded={false}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {t(
                  remaining === 0
                    ? "creditsCard.restTitle"
                    : "creditsCard.levelUpTitle"
                )}
              </p>
              {pitch != null ? (
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {t(
                    pitch === "sessions"
                      ? "creditsCard.pitchSessions"
                      : "creditsCard.pitchBots"
                  )}
                </p>
              ) : null}
              {remaining != null ? (
                <p className="text-muted-foreground mt-1 text-xs">
                  {t("creditsCard.progress", {
                    remaining: new Intl.NumberFormat(i18n.language, {
                      maximumFractionDigits: 2,
                    }).format(remaining),
                    total: new Intl.NumberFormat(i18n.language, {
                      maximumFractionDigits: 2,
                    }).format(account.data?.credits_granted ?? 0),
                  })}
                </p>
              ) : null}
              {account.data?.credits_granted != null &&
              account.data.credits_granted > 0 &&
              remaining != null ? (
                <div
                  role="progressbar"
                  aria-label={t("creditsCard.used")}
                  aria-valuemin={0}
                  aria-valuemax={account.data.credits_granted}
                  aria-valuenow={Math.min(
                    account.data.credits_granted,
                    Math.max(0, account.data.credits_used ?? 0)
                  )}
                  className="bg-muted mt-2 h-1.5 overflow-hidden rounded-full"
                >
                  <motion.div
                    className="bg-primary h-full origin-left rounded-full"
                    initial={false}
                    animate={{
                      scaleX: Math.min(
                        1,
                        Math.max(
                          0,
                          (account.data.credits_used ?? 0) /
                            account.data.credits_granted
                        )
                      ),
                    }}
                    transition={
                      preference === "reduced"
                        ? reducedTransition
                        : springs.panel
                    }
                  />
                </div>
              ) : null}
            </div>
          </div>
          <Button
            size="sm"
            className="mt-3 h-8 rounded-lg"
            onMouseEnter={() => setExcited(true)}
            onMouseLeave={() => setExcited(false)}
            onFocus={() => setExcited(true)}
            onBlur={() => setExcited(false)}
            onClick={() => void openUpgrade(transport.client)}
          >
            <Sparkles aria-hidden />
            {t("creditsCard.cta")}
          </Button>
        </motion.aside>
      ) : null}
    </AnimatePresence>,
    target
  );
};
