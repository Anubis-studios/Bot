import {
  PROVIDER_KEY_FIELDS,
  isPlausibleApiKey,
  type ProviderKeyField,
} from "@abacus-ai/contract/settings";
import { revalidateLogic } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { signInAbacus } from "#platform/sign-in";
import {
  ConnectorMark,
  markForProvider,
} from "#renderer/components/connector-mark";
import { useAppForm } from "#renderer/components/form-kit";
import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import {
  AreaPage,
  GroupCard,
  PageNote,
  SettingRow,
  StatePill,
} from "#renderer/components/form-kit/page";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { useMutation } from "#renderer/data/query-client";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { useAppContext, errorText } from "#renderer/lib/use-app-context";
import { useCreditsAccount } from "#renderer/lib/use-credits-account";
import { useNow } from "#renderer/lib/use-now";
import { Button } from "#renderer/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#renderer/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "#renderer/ui/dialog";
import { Field, FieldLabel, FieldError } from "#renderer/ui/field";
import { Input } from "#renderer/ui/input";

import { creditMarkState } from "./credits";
export const ModelsPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const navigate = useAppNavigate();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const search = useSearch({ strict: false }) as { provider?: string };
  const keys = useQuery(
    transport.orpc.settings.keys.listProviders.queryOptions({ input: {} })
  );
  const account = useCreditsAccount();
  const [q, setQ] = useState("");
  const now = useNow();
  const mark = creditMarkState(
    account.data,
    prefs.creditsExhaustedAt,
    now,
    false
  );
  const fields = PROVIDER_KEY_FIELDS.filter((p) => p.kind === "model").toSorted(
    (a, b) => Number(!!b.featured) - Number(!!a.featured)
  );
  const row = (field: ProviderKeyField) => (
    <SettingRow
      id={`provider-${field.provider}`}
      key={field.provider}
      media={
        <ConnectorMark
          id={markForProvider(field.provider) ?? field.provider}
          size={28}
        />
      }
      title={field.label}
      detail={
        keys.data?.includes(field.provider)
          ? t("phase5.savedUnverified")
          : field.envVar
      }
    >
      <StatePill>
        {t(
          keys.data?.includes(field.provider)
            ? "phase5.saved"
            : "phase5.notConnected"
        )}
      </StatePill>
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          void navigate({
            to: "/settings/models",
            search: (old) => ({ ...old, provider: field.provider }),
            transition: "none",
          })
        }
      >
        {t(
          keys.data?.includes(field.provider)
            ? "phase5.manage"
            : field.connect && IS_ELECTRON
              ? "phase5.connect"
              : "phase5.addKey"
        )}
      </Button>
    </SettingRow>
  );
  return (
    <>
      <AreaPage
        title={t("settings.pages.models")}
        description={t("phase5.settings.modelsDetail")}
      >
        {mark === "show" && (
          <GroupCard title={t("phase5.creditsExhausted")}>
            <p className="p-3 text-sm">{t("phase5.creditsAlternatives")}</p>
            <div className="flex gap-2 p-3">
              <Button
                onClick={() =>
                  void navigate({
                    to: "/settings/models",
                    search: (old) => ({ ...old, provider: "openrouter" }),
                    transition: "none",
                  })
                }
              >
                {t("phase5.connectFree")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => void update({ creditsExhaustedAt: null })}
              >
                {t("phase5.dismiss")}
              </Button>
            </div>
          </GroupCard>
        )}
        <GroupCard title={t("phase5.providers")}>
          {fields.filter((p) => p.featured).map(row)}
        </GroupCard>
        <Collapsible className="flex flex-col gap-3">
          <CollapsibleTrigger className="group/c text-muted-foreground hover:text-foreground flex items-center gap-1.5 self-start text-[13px] font-medium">
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 transition-transform group-data-[panel-open]/c:rotate-90"
            />
            {t("phase5.otherProviders")}
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-3">
            <Input
              aria-label={t("phase5.searchProviders")}
              placeholder={t("phase5.searchProviders")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <GroupCard>
              {fields
                .filter(
                  (p) =>
                    !p.featured &&
                    [p.label, p.envVar, p.hint, p.provider]
                      .join(" ")
                      .toLowerCase()
                      .includes(q.toLowerCase())
                )
                .map(row)}
            </GroupCard>
          </CollapsibleContent>
        </Collapsible>
      </AreaPage>
      {search.provider &&
        fields.find((f) => f.provider === search.provider) && (
          <ProviderDialog
            key={search.provider}
            field={fields.find((f) => f.provider === search.provider)!}
            stored={keys.data?.includes(search.provider) ?? false}
          />
        )}
    </>
  );
};
export const ProviderDialog = ({
  field,
  stored,
}: {
  field: ProviderKeyField;
  stored: boolean;
}) => {
  const { t } = useTranslation();
  const { transport, credentialsChanged } = useAppContext();
  const navigate = useAppNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const close = () =>
    void navigate({
      to: "/settings/models",
      search: (old) => ({ ...old, provider: undefined }),
      transition: "none",
    });
  const canConnect =
    field.connect && (IS_ELECTRON || field.connect === "abacus");
  const auth =
    field.connect === "abacus"
      ? transport.client.auth.abacus
      : transport.client.auth.openRouter;
  useEffect(
    () => () => {
      token.current++;
      if (IS_ELECTRON && field.connect) void auth.cancel({});
    },
    [auth, field.connect]
  );
  const refresh = async () => {
    await transport.client.models.list({ refresh: true });
    await credentialsChanged();
  };
  const saveKey = useMutation(
    transport.orpc.settings.keys.save.mutationOptions({
      onSuccess: async () => {
        await refresh();
        close();
      },
    })
  );
  const save = (key: string) =>
    saveKey.mutateAsync({ provider: field.provider, key });
  const schema = v.object({
    key: v.pipe(v.string(), v.trim(), v.check(isPlausibleApiKey, "api-key")),
  });
  const form = useAppForm({
    defaultValues: { key: "" },
    validationLogic: revalidateLogic({
      mode: "blur",
      modeAfterSubmission: "change",
    }),
    validators: { onDynamic: schema },
    onSubmit: async ({ value }) => {
      try {
        await save(v.parse(schema, value).key);
      } catch (e) {
        setError(errorText(e));
      }
    },
  });
  const connect = async () => {
    if (!canConnect) return;
    const id = ++token.current;
    setPending(true);
    setError(null);
    try {
      const result = IS_ELECTRON
        ? await auth.start({})
        : await signInAbacus(transport, {});
      if (id !== token.current) return;
      if (result.ok) {
        await refresh();
        close();
      } else if (!result.cancelled) setError(result.error);
    } catch (e) {
      if (id === token.current) setError(errorText(e));
    }
    if (id === token.current) setPending(false);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {t(canConnect ? "phase5.connectProvider" : "phase5.getKey", {
              provider: field.label,
            })}
          </DialogTitle>
          <DialogDescription>{t("phase5.storedHere")}</DialogDescription>
        </DialogHeader>
        {canConnect ? (
          <div className="flex gap-2">
            <Button disabled={pending} onClick={() => void connect()}>
              {t(pending ? "phase5.waitingSignIn" : "phase5.connect")}
            </Button>
            {pending && (
              <Button
                variant="secondary"
                onClick={() => {
                  token.current++;
                  setPending(false);
                  if (IS_ELECTRON) void auth.cancel({});
                }}
              >
                {t("phase5.cancel")}
              </Button>
            )}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
            className="space-y-3"
          >
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                void platformSystem(transport.client).openExternal({
                  url: field.signupUrl,
                })
              }
            >
              {t("phase5.openProvider", { provider: field.label })}
            </Button>
            <form.Field name="key">
              {(f) => (
                <Field>
                  <FieldLabel htmlFor="provider-key">
                    {t("phase5.apiKey")}
                  </FieldLabel>
                  <Input
                    autoFocus
                    id="provider-key"
                    type="password"
                    value={f.state.value}
                    onChange={(e) => f.handleChange(e.target.value)}
                    onBlur={f.handleBlur}
                  />
                  {f.state.meta.errors.length > 0 && (
                    <FieldError>{t("phase5.invalidKey")}</FieldError>
                  )}
                </Field>
              )}
            </form.Field>
            <form.AppForm>
              <form.SubmitButton label={t("phase5.save")} />
            </form.AppForm>
          </form>
        )}
        {error && <PageNote error>{error}</PageNote>}
        <DialogFooter>
          {stored && (
            <ConfirmAction
              title={t("phase5.removeKey", { provider: field.label })}
              description={t("phase5.removeKeyDetail")}
              label={t("phase5.remove")}
              onConfirm={() => save("")}
            />
          )}
          <Button variant="secondary" onClick={close}>
            {t("phase5.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
