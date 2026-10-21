import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ModelsPage } from "#renderer/features/settings/models";
import { ModelsSearch } from "#renderer/features/settings/search";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";

const ModelsSettingsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("settings.pages.models")}
        </span>
      </TopBarSlot>
      <ModelsPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/models")({
  validateSearch: ModelsSearch,
  component: ModelsSettingsRoute,
});
