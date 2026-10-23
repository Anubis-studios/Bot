/**
 * Watching an account whose free credits are held for a phone check, so every
 * verify surface turns the moment the platform unlocks them. The account
 * query does the reading (use-account.ts); this only says how eagerly.
 */
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Store, useStore } from "@tanstack/react-store";
import { useEffect } from "react";

import { useAppContext } from "#renderer/lib/use-app-context";

/** How often the account is read while the person may be verifying. */
export const FREE_CREDITS_POLL_MS = 10_000;
/** How long after Verify the account is polled; a window focus checks after that. */
export const FREE_CREDITS_POLL_LIMIT_MS = 10 * 60 * 1000;

const watch = new Store({ verifyClickedAt: null as number | null });

/** The platform says the free credits are held: never inferred from counters. */
export const freeCreditsHeld = (
  account: AbacusAccountInfo | null | undefined
): boolean => account?.free_credits_held === true;

/** The platform says they are not held; an older server says neither. */
export const freeCreditsUnlocked = (
  account: AbacusAccountInfo | null | undefined
): boolean => account?.free_credits_held === false;

/** Verify was clicked: poll the account for the next ten minutes. */
export const startFreeCreditsWatch = (now = Date.now()): void =>
  watch.setState(() => ({ verifyClickedAt: now }));

/** Within ten minutes of Verify. */
export const verifyRecent = (
  clickedAt = watch.state.verifyClickedAt,
  now = Date.now()
): boolean => clickedAt != null && now - clickedAt < FREE_CREDITS_POLL_LIMIT_MS;

/** Poll while the platform still says held, for ten minutes after Verify. */
export const freeCreditsPolling = (
  account: AbacusAccountInfo | null | undefined,
  now = Date.now()
): boolean => freeCreditsHeld(account) && verifyRecent(undefined, now);

/** When Verify was last clicked: the account query re-reads its interval then. */
export const useVerifyClickedAt = (): number | null =>
  useStore(watch, (state) => state.verifyClickedAt);

/**
 * Mounted by each verify surface: while one is visible, coming back to the
 * window reads the account at once (the query's own focus refetch only hears
 * visibility changes, which switching apps does not make).
 */
export const useFreeCreditsVerifySurface = (active: boolean): void => {
  const queryClient = useQueryClient();
  const { transport } = useAppContext();
  useEffect(() => {
    if (!active) return;
    const check = () =>
      void queryClient
        .refetchQueries(
          { queryKey: transport.orpc.account.abacus.key() },
          { cancelRefetch: false }
        )
        .catch(() => {});
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [active, queryClient, transport]);
};

/** Tests only. */
export const resetFreeCreditsWatch = (): void =>
  watch.setState(() => ({ verifyClickedAt: null }));
