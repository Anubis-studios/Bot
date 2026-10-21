/**
 * Main-process requests take Chromium's network stack, which honours the
 * system proxy (PAC, WPAD, VPN) and the OS certificate store. Node's fetch
 * does neither, so behind an HTTPS-scanning antivirus, a company proxy or some
 * VPNs every call from main failed its TLS handshake while the renderer and the
 * update check, both on Chromium, got through.
 *
 * Installed once, before any other main module loads, so a library that keeps
 * a reference to `globalThis.fetch` keeps this one.
 */
import tls from "node:tls";

import { app, session } from "electron";

type Fetch = typeof globalThis.fetch;

/** In memory and apart from the windows: no cookies shared either way, like Node's fetch. */
const PARTITION = "main-fetch";

/**
 * Stays on Node: a caller's own undici `dispatcher` (the web tool's SSRF
 * pinning, MCP's long-call agent) means nothing to Chromium, loopback needs no
 * proxy and Chromium refuses some ports on it, and other schemes are not network.
 */
export function staysOnNode(
  input: Parameters<Fetch>[0],
  init?: Parameters<Fetch>[1]
): boolean {
  if (init != null && "dispatcher" in init) return true;
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

function aborted(
  input: Parameters<Fetch>[0],
  init?: Parameters<Fetch>[1]
): boolean {
  if (init?.signal?.aborted === true) return true;
  return input instanceof Request && input.signal.aborted;
}

/**
 * Chromium rejects with `net::ERR_*`. Callers classify network failures by
 * the shape the fetch spec gives them, a `TypeError("fetch failed")`, so that
 * is what they get, with Chromium's reason as the cause. Aborts pass through.
 */
export function systemFetch(
  chromiumFetch: () => Promise<Fetch>,
  nodeFetch: Fetch
): Fetch {
  return async (input, init) => {
    if (staysOnNode(input, init)) return nodeFetch(input, init);
    const fetch = await chromiumFetch();
    try {
      return await fetch(input, { credentials: "omit", ...init });
    } catch (error) {
      if (aborted(input, init)) throw error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new TypeError("fetch failed", { cause: error });
    }
  };
}

/**
 * Node TLS outside fetch (websockets, requests with their own dispatcher) also
 * trusts the OS store, so an antivirus or corporate root installed there is
 * accepted as it is by Chromium. Additive: the bundled roots stay.
 */
function trustSystemCertificates(): void {
  try {
    tls.setDefaultCACertificates([
      ...new Set([
        ...tls.getCACertificates("default"),
        ...tls.getCACertificates("system"),
      ]),
    ]);
  } catch (error) {
    console.warn(
      "[system-network] system certificates unavailable:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Chromium's proxy answer (`resolveProxy`) as the variables Node reads, or null
 * when it says DIRECT or names a kind Node cannot use (SOCKS).
 */
export function proxyUrlFromPac(pac: string): string | null {
  const [kind, hostPort] = (pac.split(";")[0] ?? "").trim().split(/\s+/);
  if (hostPort == null) return null;
  if (kind === "PROXY") return `http://${hostPort}`;
  if (kind === "HTTPS") return `https://${hostPort}`;
  return null;
}

/**
 * The agent runs as a separate Node process, where Chromium's stack is out of
 * reach. It starts with `--use-system-ca` (see the artifact resolver); this
 * hands it the system proxy Chromium would use for `url`, through the
 * variables Node's fetch reads under `NODE_USE_ENV_PROXY`. A proxy the user
 * already set in the environment wins.
 */
export async function agentProxyEnv(
  url: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Record<string, string>> {
  if (env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy)
    return { NODE_USE_ENV_PROXY: "1" };
  let proxy: string | null = null;
  try {
    proxy = proxyUrlFromPac(await session.defaultSession.resolveProxy(url));
  } catch (error) {
    console.warn(
      "[system-network] proxy lookup failed:",
      error instanceof Error ? error.message : String(error)
    );
  }
  if (proxy == null) return {};
  const noProxy = [env.NO_PROXY ?? env.no_proxy, "localhost,127.0.0.1,::1"]
    .filter(Boolean)
    .join(",");
  return {
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    NO_PROXY: noProxy,
  };
}

let installed = false;

export function installSystemNetwork(): void {
  if (installed) return;
  installed = true;
  trustSystemCertificates();
  // `net` works only once the app is ready; a call made earlier waits for it.
  let ready: Promise<Fetch> | undefined;
  const chromiumFetch = () =>
    (ready ??= app.whenReady().then(() => {
      const ses = session.fromPartition(PARTITION);
      return ses.fetch.bind(ses) as Fetch;
    }));
  globalThis.fetch = systemFetch(chromiumFetch, globalThis.fetch);
}
