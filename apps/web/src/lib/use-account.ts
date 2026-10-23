import { useQuery } from "@tanstack/react-query";

import {
  FREE_CREDITS_POLL_MS,
  freeCreditsPolling,
  useVerifyClickedAt,
  verifyRecent,
} from "#renderer/lib/free-credits-watch";
import { useAppContext } from "#renderer/lib/use-app-context";

/** Name, photo, plan and credits use the same account RPC on both platforms. */
export const useAccount = () => {
  const { transport } = useAppContext();
  // Re-render on Verify, so the interval below is read again.
  const verifiedAt = useVerifyClickedAt();
  return useQuery({
    ...transport.orpc.account.abacus.queryOptions({ input: { refresh: true } }),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    // Held free credits after Verify: every few seconds, so the unlock shows
    // at once; the ten minutes are counted again after each read.
    refetchInterval: (query) =>
      freeCreditsPolling(query.state.data) ? FREE_CREDITS_POLL_MS : 300_000,
    // The person is in their browser, verifying: this window is behind it.
    refetchIntervalInBackground: verifyRecent(verifiedAt),
  });
};
