import type { CheckoutRef } from "@abacus-ai/contract/contract/checkout";
import type { PrFile } from "@abacus-ai/contract/contract/github";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DiffView } from "#renderer/components/diff-view";
import { Button } from "#renderer/ui/button";
import { Spinner } from "#renderer/ui/spinner";

import { useCheckoutQueries } from "../data/queries";
import { splitPatch } from "./pr-logic";
import { DiffStat, useOpenExternal } from "./pr-presentation";
import { PrSection } from "./pr-section";

const FileName = ({ path }: { path: string }) => {
  const slash = path.lastIndexOf("/");
  return (
    <span className="min-w-0 flex-1 truncate text-start" title={path}>
      {slash >= 0 ? (
        <span className="text-muted-foreground">
          {path.slice(0, slash + 1)}
        </span>
      ) : null}
      {path.slice(slash + 1)}
    </span>
  );
};

export const PrFiles = ({
  files,
  onOpen,
}: {
  files: readonly PrFile[];
  onOpen(path: string): void;
}) => {
  const { t } = useTranslation();
  if (!files.length) return null;
  return (
    <PrSection
      title={t("sessions.pr.files.title")}
      aside={<span className="tabular-nums">{files.length}</span>}
    >
      <ul className="-mx-2 flex flex-col">
        {files.map((file) => (
          <li key={file.path}>
            <Button
              variant="ghost"
              className="h-7 w-full justify-between gap-2 px-2 font-normal"
              onClick={() => onOpen(file.path)}
            >
              <FileName path={file.path} />
              <DiffStat additions={file.additions} deletions={file.deletions} />
            </Button>
          </li>
        ))}
      </ul>
    </PrSection>
  );
};

/**
 * The diff cut per file. A truncated diff ends mid-file: that last patch is
 * incomplete, so it is dropped and its file reads as cut off.
 */
const patchesOf = (diff: string, truncated: boolean) => {
  const files = splitPatch(diff);
  if (truncated) files.delete([...files.keys()].at(-1)!);
  return files;
};

/**
 * One file's change. The PR's whole diff is read once (`gh pr diff`) and
 * cut per file, so moving between files does not ask GitHub again.
 */
export const PrFileDiff = ({
  checkout,
  number,
  url,
  file,
  onBack,
}: {
  checkout: CheckoutRef;
  number: number;
  /** The PR on GitHub, where a file this diff cannot show is read. */
  url: string;
  file: PrFile;
  onBack(): void;
}) => {
  const { t } = useTranslation();
  const open = useOpenExternal();
  const diff = useQuery({
    ...useCheckoutQueries(checkout).pullRequestDiff(checkout, number),
    select: (data) => ({
      files: patchesOf(data.diff, data.truncated),
      truncated: data.truncated,
    }),
  });
  const patch = diff.data?.files.get(file.path);
  return (
    <div data-slot="pr-file-diff" className="flex size-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("sessions.pr.files.back")}
          onClick={onBack}
        >
          <ChevronLeft />
        </Button>
        <span className="flex min-w-0 flex-1 font-mono text-xs">
          <FileName path={file.path} />
        </span>
        <DiffStat
          additions={file.additions}
          deletions={file.deletions}
          className="px-1.5"
        />
      </div>
      <div className="min-h-0 flex-1">
        {patch ? (
          <DiffView patch={patch} />
        ) : diff.data ? (
          <div
            role="status"
            className="text-muted-foreground flex flex-col items-start gap-2 p-4 text-xs"
          >
            {diff.data.truncated
              ? t("sessions.pr.files.truncated")
              : t("sessions.pr.files.empty")}
            <Button
              variant="outline"
              size="sm"
              onClick={() => open(`${url}/files`)}
            >
              {t("sessions.pr.openOnGithub")}
            </Button>
          </div>
        ) : (
          <p
            role={diff.isError ? "alert" : "status"}
            className="text-muted-foreground flex items-center gap-2 p-4 text-xs"
          >
            {diff.isPending ? (
              <>
                <Spinner aria-hidden className="size-3.5" />
                {t("sessions.pr.files.loading")}
              </>
            ) : (
              t("sessions.pr.files.failed")
            )}
          </p>
        )}
      </div>
    </div>
  );
};
