/**
 * `paid_feature`'s card: a capability the paid plans include, named, with the
 * plan's price and the upgrade. Shown to a free account only.
 */
import { PAID_FEATURES } from "@abacus-ai/contract/toolsets";
import { parsePartialJSON } from "@tanstack/ai-client";
import type { ToolProps } from "@tanstack/ai-react/ui";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useVisibleContextualUpsell } from "#renderer/lib/contextual-upsell";
import { Button } from "#renderer/ui/button";

import type { ChatHostActions } from "../../runtime/host-actions";
import { useChatView } from "../context";
import { toolInput } from "./normalize";

export const PaidFeatureCard = ({
  feature,
  host,
}: {
  feature: string;
  host: Pick<ChatHostActions, "accountTier" | "openUpgrade">;
}) => {
  const { t } = useTranslation();
  const [free, setFree] = useState(false);
  const known = PAID_FEATURES.find((entry) => entry.feature === feature);
  const promotionRef = useVisibleContextualUpsell(free && known != null);
  useEffect(() => {
    let live = true;
    void host
      .accountTier()
      .then((tier) => {
        if (live) setFree(tier === "free");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [host]);
  if (known == null) return null;
  const name = t(`capabilities.toolsets.${known.feature}.label`);
  return (
    <div ref={promotionRef} data-slot="paid-feature" data-feature={feature}>
      {free && (
        <div className="bg-card my-2 flex w-full max-w-[520px] flex-col gap-2 rounded-xl border p-3">
          <div className="flex items-center gap-2">
            <Sparkles
              aria-hidden
              className="size-4 shrink-0 text-violet-600 dark:text-violet-400"
            />
            <span className="text-sm font-medium">
              {t(
                known.inApp
                  ? "chat.paidFeature.title"
                  : "chat.paidFeature.webTitle",
                { feature: name }
              )}
            </span>
          </div>
          <p className="text-muted-foreground text-xs leading-4">
            {`${t("upgradeDialog.price")} ${t("upgradeDialog.pricePeriod")} · ${t("upgradeDialog.plan")}`}
          </p>
          <div>
            <Button size="sm" onClick={() => void host.openUpgrade()}>
              {t("upgradeDialog.upgradeCta")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

/** The tool row: the card for the feature the call names. */
export const PaidFeatureToolCard = ({ part }: ToolProps<unknown>) => {
  const { runtime } = useChatView();
  const input = toolInput(part, parsePartialJSON);
  return part.input == null || typeof input.feature !== "string" ? null : (
    <PaidFeatureCard feature={input.feature} host={runtime.host} />
  );
};
