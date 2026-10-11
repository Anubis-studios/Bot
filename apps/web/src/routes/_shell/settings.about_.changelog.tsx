import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ChangelogPage } from "#renderer/features/settings/changelog";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";

const ChangelogRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("phase5.whatsNew")}
        </span>
      </TopBarSlot>
      <ChangelogPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/about_/changelog")({
  component: ChangelogRoute,
});
