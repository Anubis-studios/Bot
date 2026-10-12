import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import {
  Bot,
  Calendar,
  Check,
  Clock,
  Folder,
  Loader2,
  Mail,
  MessageSquare,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { creditsTier } from "#renderer/lib/credits";
import { openUpgrade } from "#renderer/lib/upgrade";
import {
  closeUpgradeDialog,
  useUpgradeDialogRequest,
  type UpgradeDialogRequest,
} from "#renderer/lib/upgrade-dialog";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import { Dialog, DialogContent, DialogTitle } from "#renderer/ui/dialog";

/** How often the dialog re-reads the account while checkout is open. */
const UPGRADE_POLL_MS = 5_000;
/** The one-time checkout link lives 30 minutes; stop polling after it. */
const UPGRADE_POLL_LIMIT_MS = 30 * 60 * 1000;

/** A free account whose Abacus credits are used up: the only one asked. */
export const spentFreeAccount = (
  account: AbacusAccountInfo | null | undefined
): boolean =>
  creditsTier(account) === "free" &&
  account?.credits_granted != null &&
  account.credits_used != null &&
  account.credits_used >= account.credits_granted;

const paying = (account: AbacusAccountInfo | null | undefined): boolean => {
  const tier = creditsTier(account);
  return tier === "basic" || tier === "paid";
};

const Feature = ({ lead, rest }: { lead?: string; rest: string }) => (
  <li className="flex gap-2.5 text-sm/5">
    <Check
      aria-hidden
      className="mt-0.5 size-4 shrink-0 text-violet-600 dark:text-violet-400"
      strokeWidth={2.4}
    />
    <span>
      {lead != null && <span className="font-semibold">{lead}</span>}
      {rest}
    </span>
  </li>
);

const Tile = ({ children }: { children: ReactNode }) => (
  <span className="bg-muted text-foreground flex size-10 items-center justify-center rounded-[11px]">
    {children}
  </span>
);

const DialogBody = ({
  request,
  onDone,
}: {
  request: UpgradeDialogRequest;
  /** `dismissed` when the person said no; not when they paid or are paying. */
  onDone: (dismissed: boolean) => void;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const { refetch: refetchAccount } = useAccount();
  const [waiting, setWaiting] = useState(false);
  const checkNow = useRef<() => void>(() => {});
  const connectors = request.kind === "connectors";

  // Checkout runs in the browser: read the account until the plan is active,
  // then send the waiting message and close.
  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    const started = Date.now();
    const check = async () => {
      const fresh = await transport.client.account
        .abacus({ refresh: true })
        .catch(() => null);
      if (stopped) return;
      if (paying(fresh)) {
        stopped = true;
        void refetchAccount();
        onDone(false);
        void request.resume?.().catch(() => {});
        return;
      }
      if (Date.now() - started > UPGRADE_POLL_LIMIT_MS) setWaiting(false);
    };
    const timer = setInterval(() => void check(), UPGRADE_POLL_MS);
    const onFocus = () => void check();
    checkNow.current = onFocus;
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      checkNow.current = () => {};
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [waiting, transport, request, onDone, refetchAccount]);

  if (waiting)
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2
          aria-hidden
          className="text-muted-foreground size-6 animate-spin"
        />
        <DialogTitle className="text-lg font-semibold">
          {t("upgradeDialog.waitingTitle")}
        </DialogTitle>
        <p className="text-muted-foreground text-sm">
          {t(
            request.resume != null && request.pendingText != null
              ? "upgradeDialog.waitingBody"
              : "upgradeDialog.waitingBodyNoMessage"
          )}
        </p>
        <div className="flex w-full flex-col gap-1.5 pt-1">
          <Button className="h-10" onClick={() => checkNow.current()}>
            {t("upgradeDialog.checkAgain")}
          </Button>
          <Button
            variant="ghost"
            className="h-10"
            onClick={() => onDone(false)}
          >
            {t("upgradeDialog.close")}
          </Button>
        </div>
      </div>
    );

  return (
    <>
      <div className="flex flex-col items-center gap-3 text-center">
        {connectors ? (
          <span aria-hidden className="flex gap-2">
            <Tile>
              <Mail className="size-5" />
            </Tile>
            <Tile>
              <Calendar className="size-5" />
            </Tile>
            <Tile>
              <MessageSquare className="size-5" />
            </Tile>
            <Tile>
              <Folder className="size-5" />
            </Tile>
            <span className="bg-primary text-primary-foreground flex size-10 items-center justify-center rounded-[11px] text-xs font-semibold">
              {t("upgradeDialog.connectorsCount")}
            </span>
          </span>
        ) : (
          <span
            aria-hidden
            className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-[14px]"
          >
            <Bot className="size-6" />
          </span>
        )}
        <p className="text-muted-foreground text-xs font-medium tracking-[0.02em]">
          {t(
            connectors
              ? "upgradeDialog.connectorsEyebrow"
              : "upgradeDialog.creditsEyebrow"
          )}
        </p>
        <DialogTitle className="text-[22px]/7 font-semibold tracking-[-0.01em] text-balance">
          {t(
            connectors
              ? "upgradeDialog.connectorsTitle"
              : "upgradeDialog.creditsTitle"
          )}
        </DialogTitle>
        <p className="text-muted-foreground text-sm/[21px]">
          {t(
            connectors
              ? "upgradeDialog.connectorsBody"
              : request.pendingText != null
                ? "upgradeDialog.creditsBody"
                : "upgradeDialog.creditsBodyNoMessage"
          )}
        </p>
      </div>
      {request.pendingText != null && (
        <div className="bg-muted flex min-w-0 items-center gap-2.5 rounded-[10px] px-3 py-2.5">
          <Clock
            aria-hidden
            className="text-muted-foreground size-4 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {t("upgradeDialog.waitingToSend", { text: request.pendingText })}
          </span>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <p className="flex items-baseline gap-2">
          {connectors && (
            <span className="text-muted-foreground text-sm">
              {t("upgradeDialog.startAt")}
            </span>
          )}
          <span className="text-[28px] font-bold tracking-[-0.02em]">
            {t("upgradeDialog.price")}
          </span>
          <span className="text-muted-foreground text-sm">
            {t("upgradeDialog.pricePeriod")}
          </span>
        </p>
        <p className="text-muted-foreground text-[13px]">
          {t("upgradeDialog.plan")}
        </p>
      </div>
      <ul className="flex flex-col gap-2.5">
        {connectors && (
          <Feature
            lead={t("upgradeDialog.featureConnectorsLead")}
            rest={t("upgradeDialog.featureConnectorsRest")}
          />
        )}
        <Feature
          lead={t("upgradeDialog.featureCreditsLead")}
          rest={t("upgradeDialog.featureCreditsRest")}
        />
        <Feature rest={t("upgradeDialog.featureModels")} />
        <Feature rest={t("upgradeDialog.featureRoutines")} />
        <Feature rest={t("upgradeDialog.featureApps")} />
        <Feature rest={t("upgradeDialog.featureMedia")} />
      </ul>
      <div className="flex flex-col gap-1.5 pt-1">
        <Button
          className="h-11 text-sm font-semibold"
          onClick={() => {
            // Called inside the click: the web build opens its tab here.
            void openUpgrade(transport.client);
            setWaiting(true);
          }}
        >
          {t("upgradeDialog.upgradeCta")}
        </Button>
        <Button
          variant="ghost"
          className="text-muted-foreground h-10 text-sm"
          onClick={() => onDone(true)}
        >
          {t(
            connectors ? "upgradeDialog.keepChatting" : "upgradeDialog.notNow"
          )}
        </Button>
      </div>
    </>
  );
};

/**
 * The window-wide upgrade dialog. It opens for a request only when a fresh
 * account read shows a free account with its credits used up, so another
 * provider's quota error that reads like ours never sells this plan.
 */
export const UpgradeDialogHost = () => {
  const request = useUpgradeDialogRequest();
  const { transport } = useAppContext();
  const [confirmed, setConfirmed] = useState<string | null>(null);

  useEffect(() => {
    if (request == null) return;
    let live = true;
    void transport.client.account
      .abacus({ refresh: true })
      .then((account) => {
        if (!live) return;
        if (spentFreeAccount(account)) setConfirmed(request.key);
        else closeUpgradeDialog();
      })
      .catch(() => {
        if (live) closeUpgradeDialog();
      });
    return () => {
      live = false;
    };
  }, [request, transport]);

  const open = request != null && confirmed === request.key;
  const done = (dismissed: boolean) => {
    setConfirmed(null);
    closeUpgradeDialog(dismissed);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && done(true)}>
      {request != null && open && (
        <DialogContent
          showCloseButton={false}
          data-slot="upgrade-dialog"
          data-kind={request.kind}
          className="gap-5 p-7 pb-5 text-sm sm:max-w-[440px] [&>*]:min-w-0"
        >
          <DialogBody request={request} onDone={done} />
        </DialogContent>
      )}
    </Dialog>
  );
};
