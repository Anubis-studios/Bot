/**
 * The three places a served tool has to agree: its definition here, the
 * `TOOLSETS` registry the Capabilities pane and the exclude list are built
 * from, and the description strings the pane shows. They used to be kept in
 * step by hand, and `design` and `deck_export_pdf` once shipped with a
 * definition and no registry entry: advertised nowhere, callable by nothing,
 * and no test noticed. So the agreement is asserted, not trusted.
 */
import fs from "fs";
import path from "path";

import { TOOLSETS } from "@abacus-ai/contract/toolsets";
import { describe, expect, it } from "vitest";

import { AGENT_TOOL_NAMES, AGENT_TOOLS, agentTool } from "./index";

/**
 * Served, switchable, and deliberately absent from the registry. Each needs
 * a reason, because the registry is where a user looks for an off switch.
 *
 * `my_activity` answers only a bot's own chat about that bot's other
 * conversations; it grants nothing and there is nothing for a user to switch.
 * `billing_plan` reads the user's own plan and prices; it grants nothing
 * either, and nor does `paid_feature`, which says where a plan has a capability. `offer_session` draws a card that opens a session; it does nothing
 * until the user clicks it.
 */
const NOT_IN_REGISTRY = new Set([
  "my_activity",
  "billing_plan",
  "paid_feature",
  "offer_session",
]);

const registryTools = new Map<string, { toolset: string; agent: boolean }>();
for (const set of TOOLSETS) {
  for (const entry of set.tools) {
    registryTools.set(entry.name, {
      toolset: set.id,
      agent: entry.agentDelivered === true,
    });
  }
}

const readyToolsetIds = new Set(
  TOOLSETS.filter((set) => set.status === "ready").map((set) => set.id)
);

const descriptions = (
  JSON.parse(
    fs.readFileSync(
      path.join(
        import.meta.dirname,
        "../../../../../../web/src/locales/en-US.json"
      ),
      "utf8"
    )
  ) as { capabilities: { toolDescriptions: Record<string, string> } }
).capabilities.toolDescriptions;

describe("every served tool", () => {
  it("has one definition", () => {
    expect(new Set(AGENT_TOOL_NAMES).size).toBe(AGENT_TOOL_NAMES.length);
    for (const name of AGENT_TOOL_NAMES) {
      expect(agentTool(name)?.name).toBe(name);
    }
  });

  it("names only toolsets that exist and are ready", () => {
    for (const definition of AGENT_TOOLS) {
      if (definition.toolsets === "always") continue;
      expect(definition.toolsets.length, definition.name).toBeGreaterThan(0);
      for (const toolset of definition.toolsets) {
        expect(
          readyToolsetIds.has(toolset),
          `${definition.name}: ${toolset}`
        ).toBe(true);
      }
    }
  });

  it("is in the Capabilities registry unless it is hidden from the model", () => {
    // A hidden tool is one the model is never told about, so a registry row
    // would advertise something the pane cannot deliver. Everything else the
    // model can see needs its off switch.
    const missing = AGENT_TOOLS.filter(
      (definition) =>
        definition.hidden !== true &&
        !NOT_IN_REGISTRY.has(definition.name) &&
        !registryTools.has(definition.name)
    ).map((definition) => definition.name);

    expect(missing).toEqual([]);
  });

  it("is listed in the registry under a toolset that can actually turn it on", () => {
    // The registry says which switch a tool sits behind; the definition says
    // which switch the server checks. A tool filed under the wrong group in
    // either place is a switch that does nothing.
    for (const definition of AGENT_TOOLS) {
      const row = registryTools.get(definition.name);
      if (row == null || definition.toolsets === "always") continue;
      expect(definition.toolsets, definition.name).toContain(row.toolset);
    }
  });

  it("is not both hidden and in the registry", () => {
    for (const definition of AGENT_TOOLS) {
      if (definition.hidden === true)
        expect(registryTools.has(definition.name), definition.name).toBe(false);
    }
  });
});

describe("the Capabilities registry", () => {
  it("names no MCP agent tool the server does not serve", () => {
    // The reverse direction: a registry row with nothing behind it is a
    // switch that lies, and a description of a tool nobody can call.
    const phantom = [...registryTools.entries()]
      .filter(
        ([name, row]) =>
          !row.agent &&
          TOOLSETS.find((set) => set.id === row.toolset)?.delivery ===
            "mcp-agent-tools" &&
          agentTool(name) == null
      )
      .map(([name]) => name);

    expect(phantom).toEqual([]);
  });

  it("has a description for every tool it lists, and no orphans", () => {
    const listed = new Set(
      TOOLSETS.flatMap((set) => set.tools.map((t) => t.descriptionKey))
    );
    const undescribed = [...listed].filter((key) => descriptions[key] == null);
    const orphaned = Object.keys(descriptions).filter(
      (key) => !listed.has(key)
    );

    expect(undescribed).toEqual([]);
    expect(orphaned).toEqual([]);
  });
});

describe("billing_plan grounds every answer about plans and credits", () => {
  it("is served in every chat, bot and chat app, on every plan, and owns those questions", () => {
    const billing = agentTool("billing_plan");
    expect(billing).toMatchObject({ toolsets: "always", botAlways: true });
    // No plan gate: a paid account, and one at zero credits, gets it too.
    expect(billing?.ready).toBeUndefined();
    expect(billing?.description).toMatch(
      /what models or\nplans cost, prices, discounts or deals, credits or balance, limits, resets or renewals/
    );
    expect(billing?.description).toMatch(
      /Never quote a price, discount, credit amount, limit or reset from memory/
    );
  });
});

describe("billing_plan's answer", () => {
  it("states the plan, the credits left, the renewal, the next plan's price and features, and the link", async () => {
    const { appBillingResult } = await import("./billing");
    const result = appBillingResult(
      {
        ok: (text: string) => ({ content: [{ type: "text", text }] }),
      } as never,
      {
        current: {
          planName: "Free",
          creditsRemaining: 0,
          creditsGranted: 2000,
          freeTierExpiresAt: null,
        },
        plans: [
          {
            plan: "free",
            planName: "Free",
            priceText: "Free",
            features: [],
            creditsPerMonth: 2000,
            current: true,
          },
          {
            plan: "basic",
            planName: "Basic",
            priceText: "$10/mo",
            firstMonthPriceCents: 700,
            priceCents: 1000,
            features: ["Image and video generation"],
            creditsPerMonth: 20000,
            current: false,
          },
        ],
        upgrades: [
          {
            plan: "basic",
            planName: "Basic",
            priceText: "$10/mo",
            firstMonthPriceCents: 700,
            priceCents: 1000,
            features: ["Image and video generation"],
            url: "https://example.test/upgrade",
          },
        ],
        topUpUrl: null,
        upgradeInMobileApp: false,
      }
    ) as unknown as { content: Array<{ text: string }> };
    const text = result.content[0]!.text;
    expect(text).toContain("The user's plan: Free.");
    expect(text).toContain("Credits left: 0 of 2,000 this month.");
    expect(text).toContain("Their plan's credits renew every month.");
    expect(text).toContain(
      "Basic: $7 for the first month (30% off the usual $10/mo), then $10/mo, link: https://example.test/upgrade"
    );
    expect(text).toContain("  - Image and video generation");
  });
});

describe("billing_plan for what only a plan does", () => {
  const plan = (current: "free" | "basic") => ({
    current: {
      planName: current === "free" ? "Free" : "Basic",
      creditsRemaining: 100,
      creditsGranted: 2000,
      freeTierExpiresAt: null,
    },
    plans: [
      {
        plan: "free",
        planName: "Free",
        priceText: "Free",
        features: [],
        creditsPerMonth: 2000,
        current: current === "free",
      },
      {
        plan: "basic",
        planName: "Basic",
        priceText: "$10/mo",
        firstMonthPriceCents: 700,
        priceCents: 1000,
        features: [
          "Routines that run 24/7 in Abacus AI Agent on the web, even with your computer off",
        ],
        creditsPerMonth: 20000,
        current: current === "basic",
      },
    ],
    upgrades:
      current === "free"
        ? [
            {
              plan: "basic",
              planName: "Basic",
              priceText: "$10/mo",
              firstMonthPriceCents: 700,
              priceCents: 1000,
              features: [
                "Routines that run 24/7 in Abacus AI Agent on the web, even with your computer off",
              ],
              url: "https://example.test/upgrade",
            },
          ]
        : [],
    topUpUrl: null,
    upgradeInMobileApp: false,
  });
  const answer = async (current: "free" | "basic") => {
    const { appBillingResult } = await import("./billing");
    const result = appBillingResult(
      {
        ok: (text: string) => ({ content: [{ type: "text", text }] }),
      } as never,
      plan(current)
    ) as unknown as { content: Array<{ text: string }> };
    return result.content[0]!.text;
  };

  it("owns 'keep running with the computer off' in its description", () => {
    expect(agentTool("billing_plan")?.description).toMatch(
      /keep running or run\nroutines while the app or computer is off, stay online 24\/7/
    );
  });

  it("a free account asking to keep running with the PC off is offered the always-on routines, priced and linked, never a no", async () => {
    const text = await answer("free");
    expect(text).toContain(
      "Asked to keep running while the app or computer is off, or to stay online 24/7: never answer no. Offer Basic"
    );
    expect(text).toContain(
      "  - Routines that run 24/7 in Abacus AI Agent on the web, even with your computer off"
    );
    expect(text).toContain("$7 for the first month");
    expect(text).toContain("link: https://example.test/upgrade");
  });

  it("a Basic account is pointed at its own 24/7 routines in Abacus AI Agent, with no upsell", async () => {
    const text = await answer("basic");
    expect(text).toContain(
      "their plan already includes routines that run 24/7 in Abacus AI Agent on the web"
    );
    expect(text).toContain("Do not offer an upgrade for it.");
    expect(text).not.toContain("never answer no. Offer");
  });
});
