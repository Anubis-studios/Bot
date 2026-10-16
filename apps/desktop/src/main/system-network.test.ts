/**
 * Main's requests take Chromium's network stack (system proxy, OS certificate
 * store); the few that must not, stay on Node, and failures keep fetch's shape.
 */
import { describe, expect, it, vi } from "vitest";

const resolveProxy = vi.hoisted(() => vi.fn(async (_url: string) => "DIRECT"));
vi.mock("electron", () => ({
  app: {},
  session: { defaultSession: { resolveProxy } },
}));

import {
  agentProxyEnv,
  proxyUrlFromPac,
  staysOnNode,
  systemFetch,
} from "./system-network";

const ok = () => Promise.resolve(new Response("ok"));

function harness(chromium: typeof fetch = vi.fn(ok)) {
  const node = vi.fn(ok);
  const chromiumFetch = vi.fn(async () => chromium);
  return { node, chromium, fetch: systemFetch(chromiumFetch, node) };
}

describe("staysOnNode", () => {
  it.each([
    "https://apps.abacus.ai/api/v0/x",
    "http://example.com/",
    "https://127.example.com/",
  ])("sends %s through Chromium", (url) => {
    expect(staysOnNode(url)).toBe(false);
    expect(staysOnNode(new URL(url))).toBe(false);
    expect(staysOnNode(new Request(url))).toBe(false);
  });

  it.each([
    "http://localhost:8080/health",
    "http://app.localhost/",
    "http://127.0.0.1:6666/health",
    "http://[::1]:9000/",
    "data:text/plain,hi",
    "not a url",
  ])("keeps %s on Node", (url) => {
    expect(staysOnNode(url)).toBe(true);
  });

  it("keeps a request with its own dispatcher on Node", () => {
    expect(
      staysOnNode("https://example.com/", {
        dispatcher: {},
      } as RequestInit)
    ).toBe(true);
  });
});

describe("systemFetch", () => {
  it("sends remote requests through Chromium without cookies", async () => {
    const h = harness();
    await h.fetch("https://apps.abacus.ai/x", { method: "POST" });
    expect(h.chromium).toHaveBeenCalledWith("https://apps.abacus.ai/x", {
      credentials: "omit",
      method: "POST",
    });
    expect(h.node).not.toHaveBeenCalled();
  });

  it("keeps loopback on Node and never waits for Chromium", async () => {
    const h = harness();
    await h.fetch("http://127.0.0.1:1234/health");
    expect(h.node).toHaveBeenCalledOnce();
    expect(h.chromium).not.toHaveBeenCalled();
  });

  it("reports a Chromium network error as fetch's TypeError, with the cause", async () => {
    const cause = new Error("net::ERR_CERT_AUTHORITY_INVALID");
    const h = harness(vi.fn(() => Promise.reject(cause)));
    const error = await h.fetch("https://apps.abacus.ai/x").catch((e) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe("fetch failed");
    expect(error.cause).toBe(cause);
  });

  it("lets an abort through unchanged", async () => {
    const controller = new AbortController();
    const reason = new DOMException("stop", "AbortError");
    const h = harness(
      vi.fn(() => {
        controller.abort(reason);
        return Promise.reject(reason);
      })
    );
    const error = await h
      .fetch("https://apps.abacus.ai/x", { signal: controller.signal })
      .catch((e) => e);
    expect(error).toBe(reason);
  });
});

describe("proxyUrlFromPac", () => {
  it.each([
    ["DIRECT", null],
    ["PROXY proxy.corp:8080; DIRECT", "http://proxy.corp:8080"],
    ["HTTPS proxy.corp:443", "https://proxy.corp:443"],
    ["SOCKS5 proxy.corp:1080", null],
    ["", null],
  ])("reads %j as %j", (pac, url) => {
    expect(proxyUrlFromPac(pac)).toBe(url);
  });
});

describe("agentProxyEnv", () => {
  it("hands the agent the system proxy, loopback excluded", async () => {
    resolveProxy.mockResolvedValueOnce("PROXY proxy.corp:8080; DIRECT");
    expect(await agentProxyEnv("https://apps.abacus.ai", {})).toEqual({
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: "http://proxy.corp:8080",
      HTTP_PROXY: "http://proxy.corp:8080",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
    expect(resolveProxy).toHaveBeenCalledWith("https://apps.abacus.ai");
  });

  it("adds nothing on a direct connection", async () => {
    expect(await agentProxyEnv("https://apps.abacus.ai", {})).toEqual({});
  });

  it("keeps a proxy the user already set", async () => {
    resolveProxy.mockClear();
    expect(
      await agentProxyEnv("https://apps.abacus.ai", {
        HTTPS_PROXY: "http://mine:3128",
      })
    ).toEqual({ NODE_USE_ENV_PROXY: "1" });
    expect(resolveProxy).not.toHaveBeenCalled();
  });

  it("adds nothing when the lookup fails", async () => {
    resolveProxy.mockRejectedValueOnce(new Error("no session"));
    expect(await agentProxyEnv("https://apps.abacus.ai", {})).toEqual({});
  });
});
