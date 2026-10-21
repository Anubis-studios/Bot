/**
 * The Abacus slice of OpenLLM's pool comes from the catalog's `route-llm-open`
 * entry: which models, in which order. The app only reads it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  abacusPool,
  abacusWire,
  OPEN_POOL_ID,
  registerAbacusProvider,
} from "./providers.js";

describe("the catalog's pool descriptor", () => {
  it("reads the members in the platform's order", () => {
    expect(
      abacusPool([
        { id: "deepseek-ai/DeepSeek-V4-Flash-0731" },
        {
          id: OPEN_POOL_ID,
          pool: ["stealth/union-alpha", "deepseek-ai/DeepSeek-V4-Flash-0731"],
        },
      ])
    ).toEqual(["stealth/union-alpha", "deepseek-ai/DeepSeek-V4-Flash-0731"]);
  });

  it("is null on a catalog that predates it, so the tier inference stands", () => {
    expect(abacusPool([{ id: "route-llm-code-low" }])).toBeNull();
    expect(abacusPool([{ id: OPEN_POOL_ID }])).toBeNull();
  });

  it("keeps only well-formed ids", () => {
    expect(
      abacusPool([{ id: OPEN_POOL_ID, pool: ["a", "", 3, null, "b"] }])
    ).toEqual(["a", "b"]);
  });
});

describe("the catalog when the fetch fails", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-catalog-"));
    vi.stubEnv("ABACUSAI_BOT_HOME", home);
    vi.stubEnv("ABACUS_API_KEY", "key-one");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** The ids the provider was registered with. */
  const registered = async (): Promise<string[]> => {
    let models: Array<{ id: string }> = [];
    const registry = {
      registerProvider: (_name: string, config: { models: typeof models }) => {
        models = config.models;
      },
    } as unknown as ModelRegistry;
    await registerAbacusProvider(registry);
    return models.map((model) => model.id);
  };

  const serving = (ids: string[]): void => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            { id: OPEN_POOL_ID, pool: ids },
            ...ids.map((id) => ({ id, model_type: "text_generation" })),
          ],
        })
      )
    );
  };
  const offline = (): void => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
  };

  it("runs on the account's last fetched catalog, not the one-model fallback", async () => {
    serving(["model-a", "model-b"]);
    const live = await registered();
    expect(live).toEqual(expect.arrayContaining(["model-a", "model-b"]));

    offline();
    expect(await registered()).toEqual(live);
  });

  it("keeps each account's catalog to itself", async () => {
    serving(["model-a"]);
    await registered();

    vi.stubEnv("ABACUS_API_KEY", "key-two");
    offline();
    const fallback = await registered();

    expect(fallback).not.toContain("model-a");
    expect(fallback.length).toBeGreaterThan(0);
  });
});

describe("the wire each Abacus model is served on", () => {
  it("is native only for the vendor's own models on their own format", () => {
    expect(
      abacusWire({ provider: "openai", api_formats: ["openai", "responses"] })
    ).toBe("openai-responses");
    expect(
      abacusWire({
        provider: "anthropic",
        api_formats: ["openai", "anthropic"],
      })
    ).toBe("anthropic-messages");
  });

  it("leaves converted, router and unlabelled models on chat completions", () => {
    expect(
      abacusWire({ provider: "deepseek", api_formats: ["openai", "responses"] })
    ).toBeUndefined();
    expect(
      abacusWire({ provider: "abacus", api_formats: ["openai", "anthropic"] })
    ).toBeUndefined();
    expect(
      abacusWire({ provider: "openai", api_formats: ["openai"] })
    ).toBeUndefined();
    expect(abacusWire({})).toBeUndefined();
  });
});

describe("the registered Abacus models", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-wire-"));
    vi.stubEnv("ABACUSAI_BOT_HOME", home);
    vi.stubEnv("ABACUS_API_KEY", "key-one");
    vi.stubEnv("ABACUSAI_BOT_ABACUS_V1", "");
    vi.stubEnv("ABACUSAI_BOT_SPONSORED_RUN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(home, { recursive: true, force: true });
  });

  type Registered = {
    id: string;
    api?: string;
    baseUrl?: string;
    compat?: Record<string, unknown>;
    thinkingLevelMap?: Record<string, string | null>;
  };

  const registered = async (): Promise<Map<string, Registered>> => {
    let models: Registered[] = [];
    const registry = {
      registerProvider: (_name: string, config: { models: Registered[] }) => {
        models = config.models;
      },
    } as unknown as ModelRegistry;
    await registerAbacusProvider(registry);
    return new Map(models.map((model) => [model.id, model]));
  };

  const serving = (): void => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            ["gpt-5.4", "openai", ["openai", "responses"]],
            ["gpt-7", "openai", ["openai", "responses"]],
            ["claude-sonnet-5", "anthropic", ["openai", "anthropic"]],
            ["claude-opus-5", "anthropic", ["openai", "anthropic"]],
            ["claude-sonnet-9", "anthropic", ["openai", "anthropic"]],
            [
              "deepseek-ai/DeepSeek-V4-Pro",
              "deepseek",
              ["openai", "responses"],
            ],
          ].map(([id, provider, formats]) => ({
            id,
            provider,
            api_formats: formats,
            model_type: "text_generation",
          })),
        })
      )
    );
  };

  it("puts OpenAI on /v1/responses and Claude on the origin the Messages SDK extends", async () => {
    serving();
    const models = await registered();

    expect(models.get("gpt-5.4")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://routellm.abacus.ai/v1",
      thinkingLevelMap: expect.objectContaining({ off: "none" }),
    });
    expect(models.get("claude-sonnet-5")).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://routellm.abacus.ai",
      compat: expect.objectContaining({ forceAdaptiveThinking: true }),
    });
    const other = models.get("deepseek-ai/DeepSeek-V4-Pro");
    expect(other?.api).toBeUndefined();
    expect(other?.compat).toEqual({ supportsDeveloperRole: false });
  });

  it("drops first-party-only Anthropic betas and defaults models pi does not know", async () => {
    serving();
    const models = await registered();

    expect(models.get("claude-opus-5")?.compat).not.toHaveProperty(
      "supportsMidConvoEffort"
    );
    expect(models.get("claude-sonnet-9")?.compat).toEqual({
      forceAdaptiveThinking: true,
    });
    expect(models.get("gpt-7")?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
    });
  });

  it("keeps a sponsored run on chat completions, the only wire that honours it", async () => {
    vi.stubEnv("ABACUSAI_BOT_SPONSORED_RUN", "chief-of-staff");
    serving();
    const models = await registered();

    expect([...models.values()].every((model) => model.api == null)).toBe(true);
  });

  it("routes the offline fallbacks the same way", async () => {
    serving();
    await registered();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    expect((await registered()).get("claude-sonnet-5")?.api).toBe(
      "anthropic-messages"
    );

    vi.stubEnv("ABACUS_API_KEY", "key-two");
    const fallback = await registered();
    expect(fallback.get("gpt-5.6-terra")?.api).toBe("openai-responses");
    expect(fallback.get("claude-opus-5")?.api).toBe("anthropic-messages");
    expect(fallback.get("route-llm-code-low")?.api).toBeUndefined();
  });
});
