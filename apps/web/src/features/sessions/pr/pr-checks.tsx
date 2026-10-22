import type { PrInfo } from "@abacus-ai/contract/contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "#renderer/ui/button";

import { CHECKS_COLLAPSE_AT, checksRollup } from "./pr-logic";
import { CheckRow, ChecksLine, useOpenExternal } from "./pr-presentation";
import { PrSection } from "./pr-section";

/**
 * The rollup, then each check in the host's order (failures, then running,
 * then passed). A long list opens on what needs a look; the passed ones are
 * a click away.
 */
export const PrChecks = ({
  pr,
}: {
  pr: Pick<PrInfo, "checks" | "ciStatus">;
}) => {
  const { t } = useTranslation();
  const open = useOpenExternal();
  const [all, setAll] = useState(false);
  const rollup = checksRollup(pr);
  const long = pr.checks.length > CHECKS_COLLAPSE_AT;
  const shown =
    long && !all ? pr.checks.filter((c) => c.status !== "success") : pr.checks;
  return (
    <PrSection
      title={t("sessions.pr.checks.title")}
      aside={
        <span className="text-foreground min-w-0">
          <ChecksLine rollup={rollup} />
        </span>
      }
    >
      {shown.length ? (
        <ul className="-mx-2 flex flex-col">
          {shown.map((check, index) => (
            <CheckRow key={index} check={check} onOpen={open} />
          ))}
        </ul>
      ) : null}
      {long ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground -mx-2 self-start"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all
            ? t("sessions.pr.checks.showLess")
            : t("sessions.pr.checks.showAll", { total: pr.checks.length })}
        </Button>
      ) : null}
    </PrSection>
  );
};
