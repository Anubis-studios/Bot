import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { useSystem } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

import { startTour } from "./store";

/** Shown once to an upgrade from the old renderer. */
export const NewLookNotice = () => {
  const db = useDb();
  const prefs = usePrefs();
  if (!useSystem().legacyInstall || prefs.dismissals.newLookSeenAt != null)
    return null;
  const seen = (tour: boolean) => {
    void db
      .updatePrefs({ dismissals: { newLookSeenAt: Date.now() } })
      .catch(() => undefined);
    if (tour) startTour({ onboarded: true });
  };
  return (
    <NewLookCard onTour={() => seen(true)} onDismiss={() => seen(false)} />
  );
};

export const NewLookCard = ({
  onTour,
  onDismiss,
}: {
  onTour: () => void;
  onDismiss: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <aside
      role="status"
      className="bg-muted animate-in fade-in-0 slide-in-from-bottom-2 fixed right-4 bottom-4 z-40 flex max-w-sm flex-col gap-3 rounded-xl border p-3 shadow-sm"
    >
      <p>{t("tour.newLook.message")}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDismiss}>
          {t("tour.newLook.dismiss")}
        </Button>
        <Button onClick={onTour}>{t("tour.newLook.start")}</Button>
      </div>
    </aside>
  );
};
