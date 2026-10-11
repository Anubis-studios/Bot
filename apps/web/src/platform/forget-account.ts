import { accountStateQuery } from "#renderer/features/onboarding/actions";
import { onboardingStore } from "#renderer/features/onboarding/store";
import { tourSignedOut } from "#renderer/features/tour/store";
import type { RouterContext } from "#renderer/router";

/** Forget the account here: its returned state applied, onboarding and the tour from the start. */
export const forgetAccount = async (context: RouterContext): Promise<void> => {
  const { transport, queryClient, db } = context;
  const state = await transport.client.account.forget({});
  queryClient.setQueryData(accountStateQuery(transport).queryKey, state);
  await db.updatePrefs({
    onboardingStep: null,
    onboardingFlow: null,
    onboardingExit: null,
    onboardingPairing: [],
    tour: { status: "unseen", at: null },
  });
  onboardingStore.setState(() => ({ signIn: null, createdBotId: null }));
  tourSignedOut();
};
