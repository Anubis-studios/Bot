import { useLocation } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { AnimatePresence, motion, animate } from "motion/react";
import { useEffect, useLayoutEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { usePrefs } from "#renderer/data/db/prefs";
import { cn } from "#renderer/lib/cn";
import { useHasContextualUpsell } from "#renderer/lib/contextual-upsell";
import { creditsTier } from "#renderer/lib/credits";
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
import { promoPlacement } from "./promo-placement";
import { promoAccountKey, promoState } from "./promo-state";

/** The boxes of visible text below `top`, which the floating card must not cover. */
const textRects = (root: Element | null, top: number): DOMRect[] => {
  if (!root) return [];
  const rects: DOMRect[] = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    if (node.parentElement?.closest('[data-slot="upgrade-promo"]')) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.bottom > top) rects.push(rect);
  }
  return rects;
};

/** One portal, shared by sidebar and floating presentations. */
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
  const location = useLocation();
  useLayoutEffect(() => {
    const previous = snapshot.current
      ? snapshot.current
      : (consumePromoRect() ?? snapshot.current);
    target.setAttribute(
      "style",
      host
        ? "pointer-events:none"
        : "position:fixed;inset:0;pointer-events:none;z-index:30"
    );
    (host?.element ?? document.body).append(target);
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
  const [position, setPosition] = useState<ReturnType<typeof promoPlacement>>({
    left: 72,
    bottom: 24,
    maxWidth: 320,
    compact: false,
    visibility: "visible",
  });
  const fullHeight = useRef(180);
  const compact = !host && position.compact;
  const compactRef = useRef(compact);
  useLayoutEffect(() => {
    compactRef.current = compact;
  }, [compact]);
  const { compact: _compact, ...floatingStyle } = position;
  const [excited, setExcited] = useState(false);
  const tier = creditsTier(account.data);
  useLayoutEffect(() => {
    if (host || !state) return;
    let frame = 0;
    const observer = new ResizeObserver(() => schedule());
    const observed = new Set<Element>();
    const measure = () => {
      const card = target.querySelector<HTMLElement>(
        '[data-slot="upgrade-promo"]'
      );
      if (card && !compactRef.current)
        fullHeight.current = card.getBoundingClientRect().height || 180;
      const controls = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-slot="composer"], [data-slot="sidebar-footer"], [data-pane-gutter], .dv-sash, [data-slot="shell"] button, [data-slot="shell"] input, [data-slot="shell"] textarea, [data-slot="shell"] [role="button"]'
        ),
      ].filter((element) => !element.closest('[data-slot="upgrade-promo"]'));
      const obstacles = [
        ...controls.map((element) => element.getBoundingClientRect()),
        // Text is content too: the card never sits on a label or a line.
        ...textRects(
          document.querySelector('[data-slot="shell"]'),
          window.innerHeight - 24 - fullHeight.current - 16
        ),
      ].filter((rect) => rect.width > 0 && rect.height > 0);
      for (const element of [
        card,
        ...document.querySelectorAll(
          '[data-slot="composer"], [data-slot="sidebar-footer"], [data-workspace-group], [data-pane-gutter], .dv-sash'
        ),
      ]) {
        if (element && !observed.has(element)) {
          observed.add(element);
          observer.observe(element);
        }
      }
      snapshot.current = card?.getBoundingClientRect() ?? null;
      const rail = document
        .querySelector('[data-slot="rail"]')
        ?.getBoundingClientRect();
      const sidebar = document
        .querySelector('[data-slot="sidebar-slot"]')
        ?.getBoundingClientRect();
      const next = promoPlacement({
        width: window.innerWidth,
        height: window.innerHeight,
        railRight: rail?.right ?? 56,
        sidebarRight: sidebar?.right ?? 56,
        cardHeight: fullHeight.current,
        obstacles,
      });
      setPosition((previous) =>
        Object.keys(next).every(
          (key) =>
            previous[key as keyof typeof next] ===
            next[key as keyof typeof next]
        )
          ? previous
          : next
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const shell = document.querySelector('[data-slot="shell"]');
    if (shell) observer.observe(shell);
    for (const element of document.querySelectorAll(
      '[data-slot="composer"], [data-slot="pane"], [data-slot="panel-workspace"]'
    ))
      observer.observe(element);
    const moves = new MutationObserver(schedule);
    if (shell) moves.observe(shell, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    // Text scrolled under the card moves without a resize or a mutation.
    window.addEventListener("scroll", schedule, true);
    return () => {
      observer.disconnect();
      moves.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [state, location.href, host, target]);
  const remaining =
    account.data?.credits_granted != null && account.data.credits_used != null
      ? Math.max(0, account.data.credits_granted - account.data.credits_used)
      : null;
  if (tier !== "free" || contextualUpsell) return createPortal(null, target);
  return createPortal(
    <AnimatePresence>
      {state ? (
        <motion.aside
          key={key}
          data-slot="upgrade-promo"
          aria-label={t("creditsCard.upsellTitle")}
          data-presentation={host ? "sidebar" : "floating"}
          data-compact={compact || undefined}
          className={cn(
            "bg-background pointer-events-auto isolate overflow-hidden rounded-(--pane-radius) border",
            compact ? "flex h-11 items-center gap-2 p-2" : "p-3",
            host ? "relative w-full" : "floating-surface fixed z-30 w-80"
          )}
          style={host ? undefined : floatingStyle}
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
          <div className={compact ? "contents" : "flex items-center gap-3"}>
            <PromoCharacter
              remaining={remaining}
              total={account.data?.credits_granted ?? null}
              excited={excited}
              upgraded={false}
              compact={compact}
              active={!!host || position.visibility !== "hidden"}
            />
            <div className={compact ? "hidden" : "min-w-0 flex-1"}>
              <p className="text-sm font-semibold">
                {t(
                  remaining === 0
                    ? "creditsCard.restTitle"
                    : "creditsCard.levelUpTitle"
                )}
              </p>
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
            className={
              compact
                ? "h-7 shrink-0 rounded-lg px-2 text-xs"
                : "mt-3 h-8 rounded-lg"
            }
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
