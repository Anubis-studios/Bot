import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Isolated fake credential and account endpoints for desktop test homes.
 * @param {string} home
 * @returns {string} The Node preload that intercepts account requests.
 */
export const authenticatedTestHome = (home) => {
  const configPath = join(home, "config.json");
  const config = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {};
  config.apiKeys = {
    ...config.apiKeys,
    ABACUS_API_KEY: "acceptance-invalid-key",
  };
  writeFileSync(configPath, JSON.stringify(config));
  // A 1.0.86 profile: without prefs.json an onboarded account is an upgrade.
  const prefsPath = join(home, "prefs.json");
  if (!existsSync(prefsPath)) writeFileSync(prefsPath, "{}");
  const preload = join(home, "fake-abacus.cjs");
  writeFileSync(
    preload,
    `
const nodeFetch = globalThis.fetch;
let realFetch = nodeFetch;
// The app installs its own fetch over this one (system-network.ts); that
// becomes the real fetch underneath, and the fake stays in front. The app's
// fetch keeps the fake as its Node fallback, so a call back in from it goes
// straight to Node rather than round again.
let inside = false;
const fakeFetch = (input, options) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (url.hostname === "abacus.ai" || url.hostname.endsWith(".abacus.ai")) {
    const body = url.pathname === "/v1/account"
      ? { id: "acceptance-account", name: "Acceptance", email: "acceptance@example.test", subscription_tier: "free", credits_granted: 100, credits_used: 0 }
      : { data: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: url.pathname === "/v1/account" || url.pathname === "/v1/models" ? 200 : 503, headers: { "content-type": "application/json" } }));
  }
  if (inside) return nodeFetch(input, options);
  inside = true;
  try {
    return realFetch(input, options);
  } finally {
    inside = false;
  }
};
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  get: () => fakeFetch,
  set: (fetch) => {
    realFetch = fetch;
  },
});
`
  );
  return preload;
};
