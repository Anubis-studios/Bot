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
import { ExternalLinkIcon } from "lucide-react";
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
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <ConnectDialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-[520px]"
        finalFocus={finalFocus}
      >
        <DialogHeader>
          <DialogTitle>{appName}</DialogTitle>
          <DialogDescription>
            {t(`messaging.descriptions.${p?.nameKey ?? platform}`, {
              defaultValue: t("phase5.messagingDescription"),
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4">
          {state && (
            <div className="flex flex-wrap items-center gap-2">
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
              {p && !p.configured && (
                <StatePill>{t("messaging.needsSetup")}</StatePill>
              )}
            </div>
          )}
          {linkRequired && (
            <p className="text-muted-foreground text-xs">
              {t("messaging.twoStepSetup", { app: appName })}
            </p>
          )}
          {(error || p?.errorMessage) && (
            <p
              role="alert"
              className={
                // Waiting on a login is an instruction, not a failure.
                !error &&
                (p?.state === "needs_login" || p?.state === "rate_limited")
                  ? "text-muted-foreground text-xs"
                  : "text-destructive text-xs"
              }
            >
              {error ?? p?.errorMessage}
            </p>
          )}
          {p?.enabled && WEB_LOGIN.has(platform) && (
            <StepSection
              title={
                linkRequired
                  ? t("messaging.stepSignIn", { app: appName })
                  : undefined
              }
            >
              <p className="text-muted-foreground text-xs">
                {t(
                  signedIn
                    ? `messaging.${platform}Connected`
                    : `messaging.${platform}Scan`
                )}
              </p>
              {!signedIn && (
                <Button
                  size="sm"
                  className="self-start"
                  onClick={() =>
                    void transport.client.messaging.showLogin({
                      platformId: platform,
                    })
                  }
                >
                  {t(`messaging.${platform}OpenLogin`)}
                </Button>
              )}
            </StepSection>
          )}
          {shared && (
            <SharedLinkSection
              platform={shared}
              required={linkRequired}
              preparing={preparing}
              retry={() =>
                void pairSharedLane(
                  { transport, queryClient: cache },
                  shared.id
                ).catch((e) =>
                  setError(e instanceof Error ? e.message : t("phase5.failed"))
                )
              }
            />
          )}
          {platform === "whatsapp" && p?.state === "syncing" && (
            <p className="text-muted-foreground text-xs">
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
          <div className="flex flex-wrap items-center justify-end gap-3">
            {setupIncomplete && p?.state === "connected" && (
              <p className="text-muted-foreground mr-auto text-xs">
                {t("messaging.finishLinkFirst")}
              </p>
            )}
            {connected && (
              <ConfirmAction
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
            )}
            {/* An unfinished setup closes as a Cancel: settling it switches the
                platform back off. */}
            <Button
              size="sm"
              variant={connected ? "default" : "outline"}
              onClick={() => void close()}
            >
              {t(
                connected ? "messaging.doneConnect" : "messaging.cancelConnect"
              )}
            </Button>
          </div>
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

const StepSection = ({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) => (
  <section className="border-border flex flex-col gap-2 rounded-lg border p-4">
    {title && (
      <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {title}
      </h3>
    )}
    {children}
  </section>
);

/**
 * Pairing with a shared Abacus-owned bot: the server mints a one-time code,
 * the user sends the bot `/link <code>`, and the section flips once it lands.
 */
const SharedLinkSection = ({
  platform,
  required,
  preparing,
  retry,
}: {
  platform: MessagingPlatformInfo;
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
  const copy = async () => {
    if (!command) return;
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const open = (target: "install" | "dm") =>
    void transport.client.messaging.openSharedLink({
      platformId: platform.id,
      target,
    });
  return (
    <StepSection
      title={t(
        required
          ? "messaging.sharedLink.stepLink"
          : "messaging.sharedLink.title"
      )}
    >
      {link.status === "linked" && (
        <p className="text-muted-foreground text-xs">
          {link.displayName
            ? t("messaging.sharedLink.linkedAs", {
                name: link.displayName,
                app,
              })
            : t("messaging.sharedLink.linked", { app })}
        </p>
      )}
      {link.status === "pending" && platform.id === "abacus_telegram" && (
        <>
          <p className="text-muted-foreground text-xs">
            {t("messaging.sharedLink.telegramStep")}
          </p>
          {link.qrDataUrl && (
            <img
              className="size-[180px] rounded-md bg-white p-1"
              src={link.qrDataUrl}
              alt={t("phase5.linkQr")}
            />
          )}
          {/* No "open link" button: the pairing has to be tapped on the phone
              that carries the account. */}
          <p className="text-muted-foreground text-xs">
            {t("messaging.sharedLink.waitingTelegram")}
          </p>
        </>
      )}
      {link.status === "pending" && platform.id !== "abacus_telegram" && (
        <>
          <p className="text-muted-foreground text-xs">
            {t("messaging.sharedLink.step1")}
          </p>
          {link.deepLink && (
            <Button
              size="sm"
              className="self-start"
              onClick={() => open("install")}
            >
              <ExternalLinkIcon data-icon="inline-start" />
              {t("messaging.sharedLink.addToDiscord")}
            </Button>
          )}
          <p className="text-muted-foreground text-xs">
            {t("messaging.sharedLink.step2Copy")}
          </p>
          {command && (
            <div className="flex items-center gap-2">
              <code className="bg-muted rounded px-2 py-1 text-xs">
                {command}
              </code>
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                {t(
                  copied
                    ? "messaging.sharedLink.copied"
                    : "messaging.sharedLink.copy"
                )}
              </Button>
            </div>
          )}
          <p className="text-muted-foreground text-xs">
            {t("messaging.sharedLink.step3Dm")}
          </p>
          {link.botProfileUrl && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => {
                // The paste is the whole of step 3: the command goes back on
                // the clipboard on the way out, in case step 2 was skipped.
                if (command) void navigator.clipboard.writeText(command);
                open("dm");
              }}
            >
              <ExternalLinkIcon data-icon="inline-start" />
              {t("messaging.sharedLink.openDm")}
            </Button>
          )}
          <p className="text-muted-foreground text-xs">
            {t("messaging.sharedLink.waiting")}
          </p>
        </>
      )}
      {(link.status === "unlinked" || link.status === "unavailable") && (
        <>
          <p className="text-muted-foreground text-xs">
            {link.error ??
              t(
                required
                  ? "messaging.sharedLink.requiredIntro"
                  : "messaging.sharedLink.intro"
              )}
          </p>
          {link.status === "unlinked" &&
            (preparing ? (
              <p className="text-muted-foreground text-xs">
                {t("messaging.sharedLink.preparing")}
              </p>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={retry}
              >
                {t(
                  required
                    ? "messaging.sharedLink.retry"
                    : "messaging.sharedLink.link"
                )}
              </Button>
            ))}
        </>
      )}
    </StepSection>
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
