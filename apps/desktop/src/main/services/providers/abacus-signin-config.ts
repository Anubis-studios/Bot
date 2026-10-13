/**
 * The server's sign-in config for this install, fetched before the app has a
 * key. Anything short of a clean answer starts nothing by itself.
 */
import { deviceId } from "../debug-sync/device-id";
import { abacusAppHost, abacusUserAgent } from "./abacus-host";

const CONFIG_PATH = "/api/v1/_getAbacusaibotSignInConfig";

// Sign-in is the front door: a slow config call must not hold it shut.
const CONFIG_TIMEOUT_MS = 3000;

interface SignInConfig {
  /** Start the sign-in without waiting for a click. */
  autoSignIn: boolean;
}

const FALLBACK: SignInConfig = { autoSignIn: false };

// One answer per launch.
let cached: SignInConfig | null = null;

const resolveSignInConfig = async (): Promise<SignInConfig> => {
  if (cached != null) return cached;

  try {
    const response = await fetch(new URL(CONFIG_PATH, abacusAppHost()), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": abacusUserAgent(),
      },
      body: JSON.stringify({ deviceId: deviceId() }),
      signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
    });
    if (!response.ok) return FALLBACK;

    const payload = (await response.json().catch(() => null)) as {
      success?: unknown;
      result?: { autoSignIn?: unknown };
    } | null;
    if (payload?.success !== true) return FALLBACK;

    cached = { autoSignIn: payload.result?.autoSignIn === true };
    return cached;
  } catch (error) {
    console.warn(
      `[abacus-auth] sign-in config unavailable: ${error instanceof Error ? error.name : "unknown"}`
    );
    return FALLBACK;
  }
};

/**
 * Whether the server asked this install to start its sign-in by itself: the
 * account was just created on the website, where its session is waiting.
 */
export const shouldAutoSignIn = async (): Promise<boolean> =>
  (await resolveSignInConfig()).autoSignIn;
