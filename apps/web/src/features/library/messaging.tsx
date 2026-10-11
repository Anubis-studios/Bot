import {
  isMessagingPlatformConnected,
  SHARED_BOT_PLATFORM_OF,
  SHARED_LINK_REQUIRED,
  type MessagingPlatformId,
  type MessagingPlatformInfo,
  type MessagingSnapshot,
  type UpdateMessagingSettingsRequest,
} from "@abacus-ai/contract/messaging";
import { useLiveQuery } from "@tanstack/react-db";
import { revalidateLogic } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { WebMessagingPage } from "#platform/whatsapp-phone";
import { ConnectorMark } from "#renderer/components/connector-mark";
import { useAppForm } from "#renderer/components/form-kit";
import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import { ConnectDialogContent } from "#renderer/components/form-kit/connect-dialog";
import { SettingSwitch, Choice } from "#renderer/components/form-kit/controls";
import {
  AreaPage,
  GroupCard,
  SettingRow,
  StatePill,
} from "#renderer/components/form-kit/page";
import { useCollections } from "#renderer/data/db";
import {
  optimistic,
  useMutation,
  useMutationState,
} from "#renderer/data/query-client";
import { cn } from "#renderer/lib/cn";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { showError } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "#renderer/ui/dialog";
import { Field, FieldGroup, FieldLabel, FieldError } from "#renderer/ui/field";
import { Input } from "#renderer/ui/input";

import {
  connectPlatform,
  disablePlatform,
  useConnectFlow,
} from "./connect-flow";
import { useMessagingDialog } from "./messaging-dialog";
export const MessagingPage = () =>
  IS_ELECTRON ? <DesktopMessagingPage /> : <WebMessagingPage />;
const DesktopMessagingPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const c = useCollections();
  const bots = useLiveQuery(c.bots).data ?? [];
  const workspaces = useLiveQuery(c.workspaces).data ?? [];
  const query = useQuery(
    transport.orpc.messaging.snapshot.queryOptions({ input: {} })
  );
  const s = query.data;
  const dialog = useMessagingDialog();
  const settings = useMutation(
    transport.orpc.messaging.updateSettings.mutationOptions({
      ...optimistic(
        transport.orpc.messaging.snapshot.queryKey({ input: {} }),
        (old, patch: UpdateMessagingSettingsRequest) => ({ ...old, ...patch })
      ),
      meta: { errorToast: "phase5.failed" },
    })
  );
  const update = (patch: UpdateMessagingSettingsRequest) =>
    settings.mutate(patch);
  return (
    <AreaPage
      title={t("library.pages.messaging")}
      description={t("phase5.messagingDescription")}
    >
      <GroupCard>
        {s?.platforms
          .filter((p) => ["whatsapp", "telegram", "discord"].includes(p.id))
          .map((p) => (
            <SettingRow
              key={p.id}
              id={p.id}
              title={t(`messaging.platforms.${p.nameKey}`)}
              detail={p.errorMessage ?? undefined}
            >
              <ConnectorMark id={p.id} size={36} />
              <StatePill>{t(`messaging.states.${p.state}`)}</StatePill>
              <Button
                size="sm"
                variant="secondary"
                data-messaging-channel={p.id}
                onClick={() => void dialog.open(p.id)}
              >
                {t(
                  p.state === "connected" ? "phase5.manage" : "phase5.connect"
                )}
              </Button>
            </SettingRow>
          ))}
      </GroupCard>
      {s && (
        <GroupCard>
          {(
            [
              ["gatewayEnabled", "phase5.messagingEnabled"],
              ["respondToInbound", "phase5.respondInbound"],
              ["autoApproveTools", "phase5.remoteUnattended"],
            ] as const
          ).map(([id, key]) => (
            <SettingRow
              key={id}
              id={id}
              title={t(key)}
              detail={
                id === "autoApproveTools"
                  ? t("phase5.remoteWarning")
                  : undefined
              }
            >
              <SettingSwitch
                id={id}
                checked={s[id]}
                onCheckedChange={(value) => update({ [id]: value })}
              />
            </SettingRow>
          ))}
          <SettingRow id="messagingWorkspace" title={t("phase5.folder")}>
            <Choice
              id="messagingWorkspace"
              value={s.workspaceId ?? ""}
              options={[
                { value: "", label: t("phase5.followWorkspace") },
                ...workspaces
                  .filter((w) => w.kind == null || w.kind === "auto")
                  .map((w) => ({ value: w.id, label: w.label ?? w.path })),
              ]}
              onChange={(workspaceId) =>
                update({ workspaceId: workspaceId || null })
              }
            />
          </SettingRow>
          <SettingRow id="messagingBot" title={t("phase5.deliverToBot")}>
            <Choice
              id="messagingBot"
              value={s.botId ?? ""}
              options={[
                { value: "", label: t("phase5.noBot") },
                ...bots.map((b) => ({ value: b.id, label: b.name })),
              ]}
              onChange={(botId) => update({ botId: botId || null })}
            />
          </SettingRow>
        </GroupCard>
      )}
      <PlatformDialog />
    </AreaPage>
  );
};
/** A messaging write answers with the whole new snapshot. */
const useWritesSnapshot = () => {
  const { transport } = useAppContext();
  const cache = useQueryClient();
  return {
    onSuccess: (next: MessagingSnapshot) =>
      cache.setQueryData(
        transport.orpc.messaging.snapshot.queryKey({ input: {} }),
        next
      ),
  };
};
/** The shared bot lane on, and a fresh link code minted for it. */
const pairSharedLane = async (
  deps: Parameters<typeof connectPlatform>[0],
  platformId: MessagingPlatformId
) => {
  await connectPlatform(deps, platformId);
  deps.queryClient.setQueryData(
    deps.transport.orpc.messaging.snapshot.queryKey({ input: {} }),
    await deps.transport.client.messaging.pairShared({ platformId })
  );
};
const PlatformDialog = () => {
  const dialog = useMessagingDialog();
  return dialog.platform ? (
    <MessagingPlatformDialog
      key={dialog.platform}
      platform={dialog.platform}
      onClose={dialog.close}
      finalFocus={dialog.finalFocus}
    />
  ) : null;
};
export const MessagingPlatformDialog = ({
  platform,
  onClose,
  finalFocus,
}: {
  platform: MessagingPlatformId;
  onClose(): Promise<void>;
  finalFocus(): HTMLElement | null;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const query = useQuery(
    transport.orpc.messaging.snapshot.queryOptions({ input: {} })
  );
  const s = query.data;
  const p = s?.platforms.find((p) => p.id === platform);
  const sharedId = SHARED_BOT_PLATFORM_OF[platform];
  const shared = s?.platforms.find((p) => p.id === sharedId);
  const flow = useConnectFlow();
  const flowRef = useRef(flow);
  useEffect(() => {
    flowRef.current = flow;
  }, [flow]);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(true);
  const [unlinking, setUnlinking] = useState(false);
  const writesSnapshot = useWritesSnapshot();
  const decide = useMutation(
    transport.orpc.messaging.decidePairing.mutationOptions(writesSnapshot)
  );
  // Per sender: deciding one leaves the others' buttons usable.
  const deciding = useMutationState({
    filters: {
      mutationKey: transport.orpc.messaging.decidePairing.mutationKey(),
      status: "pending",
    },
    select: (mutation) =>
      (mutation.state.variables as { userId: string }).userId,
  });
  const unlinkShared = useMutation(
    transport.orpc.messaging.unlinkShared.mutationOptions(writesSnapshot)
  );
  const close = async () => {
    try {
      await flow.settlePairing(platform);
      await onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("phase5.failed"));
    }
  };
  useEffect(() => {
    let live = true;
    const ready = flowRef.current.registerPairing(platform, async () => {
      const next = await connectPlatform(
        { transport, queryClient: cache },
        platform
      );
      if (!live) return;
      // The login window shows itself only while there is a login to do.
      const state = next.platforms.find((p) => p.id === platform)?.state;
      if (state !== "connected" && state !== "syncing")
        await transport.client.messaging.showLogin({ platformId: platform });
      if (!live || !sharedId || !SHARED_LINK_REQUIRED.has(platform)) return;
      const link = next.platforms.find((p) => p.id === sharedId)?.sharedLink;
      if (link == null || link.status === "unlinked")
        await pairSharedLane({ transport, queryClient: cache }, sharedId);
    });
    void ready
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : t("phase5.failed"));
      })
      .finally(() => {
        if (live) setPreparing(false);
      });
    return () => {
      live = false;
      void flowRef.current.settlePairing(platform).catch((e) => {
        if (transport.state !== "closed")
          showError(e instanceof Error ? e.message : t("phase5.failed"));
      });
    };
  }, [platform, transport, cache, sharedId, t]);
  const appName = t(`messaging.platforms.${p?.nameKey ?? platform}`);
  // Signing in is one step; where a shared bot is offered, linking it is the
  // other, and setup is not finished until both are done.
  const linkRequired =
    SHARED_LINK_REQUIRED.has(platform) &&
    shared != null &&
    shared.sharedLink?.status !== "unavailable";
  const signedIn = p?.state === "connected" || p?.state === "syncing";
  const setupIncomplete =
    linkRequired && shared?.sharedLink?.status !== "linked";
  const connected = s != null && isMessagingPlatformConnected(s, platform);
  const state =
    setupIncomplete && p?.state === "connected" ? "needs_link" : p?.state;
  const description = t(`messaging.descriptions.${p?.nameKey ?? platform}`, {
    defaultValue: t("phase5.messagingDescription"),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <ConnectDialogContent
        className="sm:max-w-[440px]"
        finalFocus={finalFocus}
      >
        <DialogHeader className="flex-row items-center gap-3">
          <ConnectorMark id={platform} size={32} />
          <DialogTitle className="text-xl font-bold tracking-tight">
            {appName}
          </DialogTitle>
          {state && (
            <span className="ml-auto">
              <StatePill
                tone={
                  connected
                    ? "success"
                    : state === "disabled"
                      ? "neutral"
                      : "warning"
                }
              >
                {t(`messaging.states.${state}`)}
              </StatePill>
            </span>
          )}
          <DialogDescription className="sr-only">
            {description}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4 text-[15px] leading-[21px]">
          <p className="text-muted-foreground">
            {linkRequired
              ? t("messaging.twoStepSetup", { app: appName })
              : description}
          </p>
          {(error || p?.errorMessage) && (
            <p
              role="alert"
              className={cn(
                "text-[13px] leading-[18px]",
                // Waiting on a login is an instruction, not a failure.
                !error &&
                  (p?.state === "needs_login" || p?.state === "rate_limited")
                  ? "text-muted-foreground"
                  : "text-destructive"
              )}
            >
              {error ?? p?.errorMessage}
            </p>
          )}
          <ol className="flex flex-col gap-4">
            {WEB_LOGIN.has(platform) && (
              <Step
                index={linkRequired ? 1 : undefined}
                done={signedIn}
                title={
                  linkRequired
                    ? t("messaging.stepSignIn", { app: appName })
                    : undefined
                }
              >
                <p className="text-muted-foreground text-[13px] leading-[18px]">
                  {t(
                    signedIn
                      ? `messaging.${platform}Connected`
                      : `messaging.${platform}Scan`
                  )}
                </p>
                {!signedIn && p?.enabled && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="self-start rounded-full"
                    onClick={() =>
                      void transport.client.messaging.showLogin({
                        platformId: platform,
                      })
                    }
                  >
                    <ExternalLinkIcon data-icon="inline-start" />
                    {t(`messaging.${platform}OpenLogin`)}
                  </Button>
                )}
              </Step>
            )}
            {shared && (
              <SharedLinkSteps
                platform={shared}
                first={linkRequired ? 2 : undefined}
                required={linkRequired}
                preparing={preparing}
                retry={() =>
                  void pairSharedLane(
                    { transport, queryClient: cache },
                    shared.id
                  ).catch((e) =>
                    setError(
                      e instanceof Error ? e.message : t("phase5.failed")
                    )
                  )
                }
              />
            )}
          </ol>
          {platform === "whatsapp" && p?.state === "syncing" && (
            <p className="text-muted-foreground text-[13px] leading-[18px]">
              {t("messaging.whatsappSyncing")}
            </p>
          )}
          {p && p.fields.length > 0 && <PlatformCredentials platform={p} />}
          {s?.pending
            .filter((u) => u.platform === platform)
            .map((u) => (
              <SettingRow
                key={u.userId}
                id={u.userId}
                title={u.userName ?? u.userId}
                detail={u.firstMessage ?? ""}
              >
                {(["approve", "revoke"] as const).map((decision) => (
                  <Button
                    key={decision}
                    size="sm"
                    variant={decision === "approve" ? "default" : "ghost"}
                    disabled={deciding.includes(u.userId)}
                    onClick={() =>
                      decide.mutate({
                        platformId: platform,
                        userId: u.userId,
                        decision,
                      })
                    }
                  >
                    {t(
                      decision === "approve"
                        ? "phase5.approve"
                        : "phase5.reject"
                    )}
                  </Button>
                ))}
              </SettingRow>
            ))}
          {s?.autoReplies
            .filter((u) => u.platform === platform)
            .map((u) => (
              <SettingRow
                key={u.userId}
                id={u.userId}
                title={u.userName ?? u.userId}
                detail={u.status}
              >
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={deciding.includes(u.userId)}
                  onClick={() =>
                    decide.mutate({
                      platformId: platform,
                      userId: u.userId,
                      decision: u.status === "paused" ? "resume" : "pause",
                    })
                  }
                >
                  {t(u.status === "paused" ? "phase5.resume" : "phase5.pause")}
                </Button>
                <ConfirmAction
                  title={t("phase5.revokeTitle")}
                  description={t("phase5.revokeDescription")}
                  label={t("phase5.revoke")}
                  onConfirm={() =>
                    decide.mutateAsync({
                      platformId: platform,
                      userId: u.userId,
                      decision: "revoke",
                    })
                  }
                />
              </SettingRow>
            ))}
          {setupIncomplete && signedIn && (
            <p
              role="status"
              className="text-muted-foreground flex items-center justify-center gap-2 text-[13px]"
            >
              <span className="size-2 animate-pulse rounded-full bg-[var(--chat-status-attention)]" />
              {t("messaging.finishLinkFirst")}
            </p>
          )}
          {/* An unfinished setup closes as a Cancel: settling it switches the
              platform back off. */}
          <Button
            size="lg"
            variant={connected ? "default" : "secondary"}
            className="h-12 rounded-full text-base"
            onClick={() => void close()}
          >
            {t(connected ? "messaging.doneConnect" : "messaging.cancelConnect")}
          </Button>
          {connected && (
            <>
              <Button
                size="lg"
                variant="ghost"
                className="text-destructive h-12 rounded-full text-base"
                onClick={() => setUnlinking(true)}
              >
                {t("phase5.unlink")}
              </Button>
              <ConfirmAction
                open={unlinking}
                onOpenChange={setUnlinking}
                title={t("phase5.unlinkTitle")}
                description={t("phase5.unlinkDescription")}
                label={t("phase5.unlink")}
                onConfirm={async () => {
                  if (sharedId)
                    await unlinkShared.mutateAsync({ platformId: sharedId });
                  await disablePlatform(
                    { transport, queryClient: cache },
                    platform
                  );
                }}
              />
            </>
          )}
        </div>
      </ConnectDialogContent>
    </Dialog>
  );
};

/** Platforms whose login is the platform's own page in a window of its own. */
const WEB_LOGIN = new Set<MessagingPlatformId>([
  "whatsapp",
  "telegram",
  "discord",
]);

/** One step of a connect; numbered only when there is more than one. */
const Step = ({
  index,
  done = false,
  title,
  children,
}: {
  index?: number;
  done?: boolean;
  title?: string;
  children?: ReactNode;
}) => (
  <li className="flex items-start gap-3">
    {index != null && (
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold",
          done
            ? "bg-[var(--chat-status-done)]/15 text-[var(--chat-status-done)]"
            : "bg-muted"
        )}
      >
        {done ? <CheckIcon className="size-3.5" /> : index}
      </span>
    )}
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      {title && <span className="font-medium">{title}</span>}
      {children}
    </div>
  </li>
);

/**
 * Pairing with a shared Abacus-owned bot: the server mints a one-time code,
 * the user sends the bot `/link <code>`, and the steps flip once it lands.
 */
const SharedLinkSteps = ({
  platform,
  first,
  required,
  preparing,
  retry,
}: {
  platform: MessagingPlatformInfo;
  first?: number;
  required: boolean;
  preparing: boolean;
  retry(): void;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const [copied, setCopied] = useState(false);
  const link = platform.sharedLink ?? { status: "unlinked" as const };
  const command = link.code ? `/link ${link.code}` : null;
  const app = t(`messaging.platforms.${platform.nameKey}`);
  const title = t(
    required ? "messaging.sharedLink.stepLink" : "messaging.sharedLink.title"
  );
  const note = "text-muted-foreground text-[13px] leading-[18px]";
  const open = (target: "install" | "dm") =>
    void transport.client.messaging.openSharedLink({
      platformId: platform.id,
      target,
    });
  const copy = async () => {
    if (!command) return;
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const waiting = (text: string) => (
    <p role="status" className={cn(note, "flex items-center gap-2")}>
      <span className="size-2 animate-pulse rounded-full bg-[var(--chat-status-attention)]" />
      {text}
    </p>
  );
  if (link.status === "linked")
    return (
      <Step index={first} done title={title}>
        <p className={note}>
          {link.displayName
            ? t("messaging.sharedLink.linkedAs", {
                name: link.displayName,
                app,
              })
            : t("messaging.sharedLink.linked", { app })}
        </p>
      </Step>
    );
  if (link.status === "pending" && platform.id === "abacus_telegram")
    return (
      <Step index={first} title={title}>
        <p className={note}>{t("messaging.sharedLink.telegramStep")}</p>
        {link.qrDataUrl && (
          <img
            className="size-[180px] self-center rounded-[18px] border bg-white p-2"
            src={link.qrDataUrl}
            alt={t("phase5.linkQr")}
          />
        )}
        {/* No "open link" button: the pairing has to be tapped on the phone
            that carries the account. */}
        {waiting(t("messaging.sharedLink.waitingTelegram"))}
      </Step>
    );
  if (link.status === "pending") {
    const at = (offset: number) => (first == null ? undefined : first + offset);
    return (
      <>
        <Step index={at(0)} title={t("messaging.sharedLink.step1")}>
          {link.deepLink && (
            <Button
              size="sm"
              variant="secondary"
              className="self-start rounded-full"
              onClick={() => open("install")}
            >
              <ExternalLinkIcon data-icon="inline-start" />
              {t("messaging.sharedLink.addToDiscord")}
            </Button>
          )}
        </Step>
        <Step index={at(1)} title={t("messaging.sharedLink.step2Copy")}>
          {command && (
            <div className="bg-background flex items-center justify-between gap-3 rounded-[14px] border py-2 pr-2 pl-3">
              <code className="font-mono text-sm">{command}</code>
              <Button
                size="sm"
                variant="secondary"
                className="rounded-full"
                onClick={() => void copy()}
              >
                {t(
                  copied
                    ? "messaging.sharedLink.copied"
                    : "messaging.sharedLink.copy"
                )}
              </Button>
            </div>
          )}
        </Step>
        <Step index={at(2)} title={t("messaging.sharedLink.step3Dm")}>
          {link.botProfileUrl && (
            <Button
              size="sm"
              variant="secondary"
              className="self-start rounded-full"
              onClick={() => {
                // The paste is the whole of this step: the command goes back
                // on the clipboard on the way out, in case the copy was skipped.
                if (command) void navigator.clipboard.writeText(command);
                open("dm");
              }}
            >
              <ExternalLinkIcon data-icon="inline-start" />
              {t("messaging.sharedLink.openDm")}
            </Button>
          )}
          {waiting(t("messaging.sharedLink.waiting"))}
        </Step>
      </>
    );
  }
  return (
    <Step index={first} title={title}>
      <p className={link.error ? "text-destructive text-[13px]" : note}>
        {link.error ??
          t(
            required
              ? "messaging.sharedLink.requiredIntro"
              : "messaging.sharedLink.intro"
          )}
      </p>
      {link.status === "unlinked" &&
        (preparing ? (
          waiting(t("messaging.sharedLink.preparing"))
        ) : (
          <Button
            size="sm"
            variant="secondary"
            className="self-start rounded-full"
            onClick={retry}
          >
            {t(
              required
                ? "messaging.sharedLink.retry"
                : "messaging.sharedLink.link"
            )}
          </Button>
        ))}
    </Step>
  );
};

const PlatformCredentials = ({
  platform,
}: {
  platform: MessagingPlatformInfo;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const writesSnapshot = useWritesSnapshot();
  const save = useMutation(
    transport.orpc.messaging.updatePlatform.mutationOptions({
      ...writesSnapshot,
      meta: { errorToast: "phase5.saveFailed" },
    })
  );
  const schema = v.object(
    Object.fromEntries(
      platform.fields.map((field) => [
        field.key,
        v.pipe(
          v.string(),
          v.trim(),
          v.check(
            (value) => !field.required || field.isSet || value.length > 0,
            "required"
          )
        ),
      ])
    )
  );
  const form = useAppForm({
    defaultValues: Object.fromEntries(
      platform.fields.map((field) => [field.key, ""])
    ),
    validationLogic: revalidateLogic({
      mode: "blur",
      modeAfterSubmission: "change",
    }),
    validators: { onDynamic: schema },
    onSubmit: async ({ value }) => {
      const values = Object.fromEntries(
        Object.entries(v.parse(schema, value)).filter(
          ([, value]) => value !== ""
        )
      );
      // A failure is toasted by the mutation's meta; the fields keep it.
      await save.mutateAsync({ platformId: platform.id, values }).then(
        () => form.reset(),
        () => undefined
      );
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        {platform.fields.map((field) => (
          <form.Field key={field.key} name={field.key}>
            {(f) => (
              <Field data-invalid={f.state.meta.errors.length > 0}>
                <FieldLabel htmlFor={`messaging-${field.key}`}>
                  {t(`messaging.fields.${field.labelKey}`, {
                    defaultValue: field.key,
                  })}
                </FieldLabel>
                <Input
                  id={`messaging-${field.key}`}
                  type={field.secret ? "password" : "text"}
                  value={f.state.value}
                  placeholder={field.redactedValue ?? ""}
                  disabled={field.fromEnv}
                  aria-invalid={f.state.meta.errors.length > 0}
                  onChange={(event) => f.handleChange(event.target.value)}
                  onBlur={f.handleBlur}
                />
                {f.state.meta.errors.length > 0 && (
                  <FieldError>{t("messaging.required")}</FieldError>
                )}
              </Field>
            )}
          </form.Field>
        ))}
        <form.AppForm>
          <form.SubmitButton label={t("phase5.save")} />
        </form.AppForm>
      </FieldGroup>
    </form>
  );
};
