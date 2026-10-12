import type { Transport } from "#renderer/data/transport";
import { ConnectAttempt } from "#renderer/lib/connect-page";
import { IS_ELECTRON } from "#renderer/lib/platform";

const claim = (key: string): boolean => {
  try {
    if (localStorage.getItem(key) != null) return false;
    localStorage.setItem(key, "started");
    return true;
  } catch {
    return false;
  }
};

/** One Google consent covers these: any of them connected means Google is. */
const GOOGLE_CONNECTORS = [
  "abacus-gmailuser",
  "abacus-googlecalendar",
  "abacus-googledriveuser",
] as const;

/**
 * Desktop, once per install: an account that signs in with Google has
 * Google's consent opened after sign-in, unless Google is connected already
 * (a website sign-up may have done it). Nobody else is asked.
 */
export const startFirstRunGmail = async (
  transport: Transport,
  googleSignIn: boolean
): Promise<void> => {
  if (!IS_ELECTRON || !googleSignIn) return;
  const statuses = await transport.client.connectors.statuses({});
  if (
    statuses["abacus-gmailuser"]?.state !== "available" ||
    GOOGLE_CONNECTORS.some((id) => statuses[id]?.state === "connected") ||
    !claim("abacusai-bot:onboarding.gmailHop")
  )
    return;
  void new ConnectAttempt(transport, "abacus-gmailuser").result
    .then((outcome) =>
      transport.client.system.funnelStep({
        step: outcome.ok ? "gmail_allowed" : "gmail_declined",
      })
    )
    .catch(() => {});
};

/**
 * The browser arrives signed in to the website, so its host signs in with
 * that session whenever it is not signed in yet: once per page load (a
 * remount or a failed attempt never loops), for every account this browser
 * uses. Never once per browser: a second account would meet the sign-up wall.
 */
let webSignInStarted = false;

/** Whether this page load's browser hand-off has started (the welcome offers Try again after). */
export const websiteSignInStarted = (): boolean => webSignInStarted;

/**
 * Desktop: once per install, so cancelling or signing out does not reopen
 * the wall's hop. Browser: see `webSignInStarted`.
 */
export const startWebsiteSignIn = async (
  transport: Transport,
  start: () => void
): Promise<void> => {
  if (!IS_ELECTRON) {
    if (webSignInStarted) return;
    webSignInStarted = true;
    start();
    return;
  }
  if (!(await transport.client.auth.abacus.shouldAutoSignIn({}))) return;
  if (!claim("abacusai-bot:onboarding.autoSignIn")) return;
  await transport.client.system.funnelStep({ step: "auto_signin" });
  start();
};
