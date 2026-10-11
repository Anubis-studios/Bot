import { TextPart } from "@tanstack/ai-react/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import {
  AreaPage,
  GroupCard,
  StatePill,
} from "#renderer/components/form-kit/page";
import { parseChangelog } from "#renderer/lib/changelog";
import { useAppContext } from "#renderer/lib/use-app-context";

import changelog from "../../../../../CHANGELOG.md?raw";
export const ChangelogPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const info = useQuery(transport.orpc.system.info.queryOptions({ input: {} }));
  return (
    <AreaPage title={t("phase5.whatsNew")}>
      {parseChangelog(changelog).map((release) => (
        <GroupCard key={release.version}>
          <div className="flex items-center gap-3 p-3">
            <h2 className="text-sm font-semibold">{release.version}</h2>
            {release.version === info.data?.appVersion && (
              <StatePill>{t("phase5.thisVersion")}</StatePill>
            )}
            <time className="text-muted-foreground text-xs">
              {release.date}
            </time>
          </div>
          <div className="chat-prose px-4 pb-4 text-sm [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:font-semibold [&_li]:my-1 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:ps-5 [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:ps-5">
            <TextPart content={release.body} role="assistant" />
          </div>
        </GroupCard>
      ))}
    </AreaPage>
  );
};
