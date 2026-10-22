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
