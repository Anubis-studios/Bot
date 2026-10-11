import { tourSignedOut } from "#renderer/features/tour/store";
import type { RouterContext } from "#renderer/router";

export const signOutAbacus = async (
  context: RouterContext,
  keepOtherApiKeys: boolean
): Promise<void> => {
  await context.transport.client.auth.abacus.signOut({ keepOtherApiKeys });
  await context.transport.client.account.signOut({});
  tourSignedOut();
  await context.credentialsChanged();
};
