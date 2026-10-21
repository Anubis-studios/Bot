/**
 * The WhatsApp chat reads only its own tool words. Every agent-tools tool on
 * the phone's roster has a phone definition (tools/phone) over the engine the
 * app's tool runs, or is on the not-yet list, which only shrinks; nothing
 * else reaches it, listed or called. The app's listing is untouched.
 */
import fs from "fs";
import path from "path";

import { WHATSAPP_CHANNEL } from "@abacus-ai/agent/channel";
import {
  PHONE_AGENT_TOOL_NAMES,
  PHONE_MCP_TOOLS,
  PHONE_VAULT_TOOL_NAMES,
} from "@abacus-ai/agent/tool-policy";
import type { ConnectorStatuses } from "@abacus-ai/contract/contracts";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BillingPlan } from "../providers/abacus-upgrade";
import { McpAgentToolsServer } from "./mcp-agent-tools-server";
import type { McpToolListing } from "./mcp-http-server";
import { AGENT_TOOL_NAMES } from "./tools";
import {
  NOT_YET_PHONE_OWNED,
  NOT_YET_PHONE_OWNED_VAULT,
  PHONE_AGENT_TOOLS,
} from "./tools/phone";

const PHONE = "phone-session";

/**
 * Product nouns a WhatsApp user can do nothing with, read over the phone
 * files' source. English only: these files are written in English.
 */
const APP_ONLY =
  /\bpanes?\b|\bCapabilities\b|\bConnect (card|button)\b|\b(Routines|Plugins|Connectors) (panel|page)\b|\bfiles card\b|\bsidebar\b|\bin the app\b|localhost|127\.0\.0\.1|file:\/\/|(?<![\w/.:])(\/home\/|\/tmp\/|\/Users\/)/i;

/**
 * FROZEN: the largest the not-yet list may be. Shrink this copy with the list
 * when a phone definition lands; never grow either.
 */
const NOT_YET_MAX_LENGTH = 10;
/** FROZEN: the vault tools still on the browser server's one wording. */
const NOT_YET_VAULT_AT_MOST = [
  "vault_items",
  "vault_request",
  "payment_approval",
  "signin_approval",
];
const NOT_YET_AT_MOST = [
  "skills_list",
  "skill_view",
  "cronjob",
  "vision_analyze",
  "video_analyze",
  "x_search",
  "pdf",
  "deck_export_pdf",
  "serve",
  "present_deliverable",
];

const account = vi.hoisted(() => vi.fn());
const billingPlan = vi.hoisted(() => vi.fn());

vi.mock("../providers/abacus", async (original) => ({
  ...(await original<typeof import("../providers/abacus")>()),
  fetchAbacusAccount: account,
}));
vi.mock("../providers/abacus-upgrade", async (original) => ({
  ...(await original<typeof import("../providers/abacus-upgrade")>()),
  fetchBillingPlan: billingPlan,
}));
/** The media providers' keys this machine has; any other credential reads as usual. */
const mediaKeys = vi.hoisted(() => new Map<string, string>());
const MEDIA_KEYS = [
  "ABACUS_API_KEY",
  "OPENAI_API_KEY",
  "FAL_KEY",
  "ELEVENLABS_API_KEY",
  "BFL_API_KEY",
];
vi.mock("../config/settings", async (original) => {
  const actual = await original<typeof import("../config/settings")>();
  return {
    ...actual,
    credentialFor: (name: string) =>
      MEDIA_KEYS.includes(name)
        ? (mediaKeys.get(name) ?? "")
        : actual.credentialFor(name),
  };
});

let statuses: ConnectorStatuses;
const link = vi.fn(async (connectorId: string) =>
  connectorId.startsWith("abacus-")
    ? {
        url: `https://apps.example/connect?service=${connectorId.slice("abacus-".length)}&r=req`,
        connectorIds: [connectorId],
      }
    : null
);
const show = vi.fn();
const watch = vi.fn();
const disablePlatform = vi.fn(async () => {});
const disconnect = vi.fn(async () => null);

const server = (): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () =>
      new Set(["connectors", "todo", "cronjob", "pdf", "memory"]),
    workspacePath: () => null,
    channelForSession: (session: string) =>
      session === PHONE ? WHATSAPP_CHANNEL : null,
    conversationKeyForSession: (session: string) =>
      sessionConversationKey("ws-1", session),
    connectors: { list: async () => statuses, link, show, watch, disconnect },
    messaging: {
      runningPlatforms: () => ["whatsapp"] as never,
      livePlatforms: () => ["whatsapp"] as never,
      disablePlatform,
      listChats: () => [],
      send: async () => undefined as never,
      readMessages: async () => [] as never,
    } as never,
  } as never);

const listTools = (session?: string): McpToolListing[] =>
  (
    server() as unknown as { listTools: (s?: string) => McpToolListing[] }
  ).listTools(session);

const call = async (
  name: string,
  args: Record<string, unknown>,
  session = PHONE
): Promise<{ text: string; isError: boolean }> => {
  const result = (await server().executeTool(name, args, session)) as {
    content: Array<{ text?: string }>;
    isError?: boolean;
  };
  return {
    text: result.content.map((part) => part.text ?? "").join("\n"),
    isError: result.isError === true,
  };
};

beforeEach(() => {
  statuses = {};
  mediaKeys.clear();
  vi.clearAllMocks();
});

describe("the phone's tool words", () => {
  it("come from a phone definition for every tool on its roster, or the shrinking not-yet list", () => {
    const owned = new Set(PHONE_AGENT_TOOLS.map((tool) => tool.name));
    expect(NOT_YET_AT_MOST).toHaveLength(NOT_YET_MAX_LENGTH);
    expect(NOT_YET_PHONE_OWNED.length).toBeLessThanOrEqual(NOT_YET_MAX_LENGTH);
    expect(new Set(NOT_YET_PHONE_OWNED).size).toBe(NOT_YET_PHONE_OWNED.length);
    for (const name of NOT_YET_PHONE_OWNED) {
      expect(NOT_YET_AT_MOST, `${name}: write its phone definition`).toContain(
        name
      );
      expect(owned.has(name), `${name} is phone-owned already`).toBe(false);
    }
    for (const definition of PHONE_AGENT_TOOLS)
      expect(definition.surface).toBe("phone");
    expect(new Set([...owned, ...NOT_YET_PHONE_OWNED])).toEqual(
      new Set(PHONE_AGENT_TOOL_NAMES)
    );
    // The vault's tools, signin_approval among them: each on the phone's
    // roster is on the not-yet list until its phone definition lands.
    for (const name of NOT_YET_PHONE_OWNED_VAULT)
      expect(NOT_YET_VAULT_AT_MOST, name).toContain(name);
    expect(new Set(NOT_YET_PHONE_OWNED_VAULT)).toEqual(
      new Set(PHONE_VAULT_TOOL_NAMES)
    );
    for (const name of PHONE_MCP_TOOLS.builtin.filter((tool) =>
      AGENT_TOOL_NAMES.includes(tool)
    ))
      expect(
        owned.has(name) || NOT_YET_PHONE_OWNED.includes(name),
        `${name}: on the phone's roster with no phone definition`
      ).toBe(true);
  });

  it("lists the phone nothing else, and refuses a call to anything else", async () => {
    const listed = listTools(PHONE).map((tool) => tool.name);
    const allowed = new Set([
      ...PHONE_AGENT_TOOLS.map((tool) => tool.name),
      ...NOT_YET_PHONE_OWNED,
    ]);
    for (const name of listed) expect(allowed.has(name), name).toBe(true);
    expect(listed).toEqual(
      expect.arrayContaining(["connect_connector", "disconnect_connector"])
    );
    expect(listed).not.toContain("todo");
    expect(await call("todo", { action: "list" })).toEqual({
      text: "Unknown tool: todo",
      isError: true,
    });
  });

  it("serves the phone's own connector words, and the app keeps its own", () => {
    const phone = listTools(PHONE).find(
      (tool) => tool.name === "connect_connector"
    );
    const app = listTools("ui-session").find(
      (tool) => tool.name === "connect_connector"
    );
    expect(phone?.description).not.toMatch(APP_ONLY);
    expect(JSON.stringify(phone?.inputSchema)).not.toMatch(APP_ONLY);
    expect(app?.description).toContain("Connect card up in the app");
  });

  it("never names an app-only thing in a phone file", () => {
    const dir = path.join(__dirname, "tools", "phone");
    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      expect(
        fs.readFileSync(path.join(dir, file), "utf8").replace(APP_ONLY, ""),
        file
      ).toBe(fs.readFileSync(path.join(dir, file), "utf8"));
  });
});

describe("connect_connector on the phone", () => {
  it("sends a link for an account connector, with no card", async () => {
    const { text } = await call("connect_connector", { service: "gmail" });
    expect(text).toContain(
      "https://apps.example/connect?service=gmailuser&r=req"
    );
    expect(show).not.toHaveBeenCalled();
    expect(text).not.toMatch(APP_ONLY);
  });

  it("says plainly what cannot be connected from WhatsApp, and claims no card", async () => {
    const { text } = await call("connect_connector", { service: "telegram" });
    expect(text).toBe(
      "Telegram cannot be connected or used from WhatsApp. Say so plainly in one short line, and do whatever part of the task does not need it."
    );
    expect(show).not.toHaveBeenCalled();
  });

  it("never offers a connected chat app's tools: the phone cannot use them", async () => {
    statuses = { "messaging-telegram": { state: "connected" } } as never;
    const { text } = await call("connect_connector", { service: "telegram" });
    expect(text).toMatch(
      /^Telegram cannot be connected or used from WhatsApp\./
    );
    expect(text).not.toMatch(/send_<platform>_message|tool list/);
  });

  it("lists only what the user can connect from the chat: Google and GitHub, and what is connected already", async () => {
    statuses = {
      "abacus-outlook": { state: "connected", account: "ada@example.com" },
    } as never;
    const { text } = await call("connect_connector", {});
    for (const id of [
      "abacus-gmailuser",
      "abacus-googledriveuser",
      "abacus-googlecalendar",
      "abacus-githubbot",
    ])
      expect(text).toContain(`${id}  `);
    expect(text).toContain(
      "abacus-outlook  Outlook  connected as ada@example.com"
    );
    expect(text).not.toMatch(/slack|jira|dropbox|telegram|discord/i);
    expect(text).not.toMatch(APP_ONLY);
  });

  it("names only Google and GitHub to connect in its description", () => {
    const phone = listTools(PHONE).find(
      (tool) => tool.name === "connect_connector"
    );
    expect(phone?.description).toContain(
      "Gmail, Google Drive, Google Calendar, GitHub."
    );
    expect(phone?.description).not.toMatch(/slack|outlook/i);
  });

  it("links GitHub", async () => {
    const { text } = await call("connect_connector", { service: "github" });
    expect(text).toContain(
      "https://apps.example/connect?service=githubbot&r=req"
    );
  });
});

describe("a service the phone does not connect", () => {
  const OFFER: BillingPlan = {
    current: {
      planName: "Free",
      creditsRemaining: 100,
      creditsGranted: 100,
      freeTierExpiresAt: null,
    },
    plans: [
      {
        plan: "basic",
        planName: "Basic",
        priceText: "$1 the first month",
        features: ["More credits"],
        creditsPerMonth: 2000,
        current: false,
      },
    ],
    upgrades: [
      {
        plan: "basic",
        planName: "Basic",
        priceText: "$1 the first month",
        features: ["More credits"],
        url: "https://apps.example/upgrade/one-time",
      },
    ],
    topUpUrl: null,
    upgradeInMobileApp: false,
  };

  beforeEach(() => {
    account.mockResolvedValue({ subscription_tier: "free", plan: "Free" });
    billingPlan.mockResolvedValue(OFFER);
  });

  it.each(["slack", "Outlook", "x (twitter)", "jira"])(
    "gets no link for %s, and on the free plan the upgrade pitch from the platform's offer",
    async (service) => {
      const { text } = await call("connect_connector", { service });
      expect(link).not.toHaveBeenCalled();
      expect(watch).not.toHaveBeenCalled();
      expect(billingPlan).toHaveBeenCalledWith(true);
      expect(text).toContain("no link was made for it: send none");
      expect(text).toContain("not part of the free plan on WhatsApp");
      expect(text).toContain("the ChatLLM\napp on their phone");
      expect(text).toContain(
        "Basic: $1 the first month, 2,000 credits a month, link: https://apps.example/upgrade/one-time"
      );
      expect(text).toContain("at most once in this conversation");
      expect(text).toContain("in their language");
      expect(text).not.toContain("apps.example/connect");
    }
  );

  it("sends a paid user to the ChatLLM app, with no pitch", async () => {
    account.mockResolvedValue({ subscription_tier: "pro", plan: "Pro" });
    const { text } = await call("connect_connector", { service: "slack" });
    expect(link).not.toHaveBeenCalled();
    expect(billingPlan).not.toHaveBeenCalled();
    expect(text).toContain("connect it in the ChatLLM app");
    expect(text).toContain("Do not pitch an upgrade");
    expect(text).not.toContain("free plan");
  });

  it("points to billing_plan when the offer cannot be read", async () => {
    billingPlan.mockResolvedValue(null);
    const { text } = await call("connect_connector", { service: "slack" });
    expect(link).not.toHaveBeenCalled();
    expect(text).toContain("call billing_plan with upgrade: true");
  });

  it("keeps working once the user connected it elsewhere", async () => {
    statuses = {
      "abacus-slack": { state: "connected", account: "ada@example.com" },
    } as never;
    const { text } = await call("connect_connector", { service: "slack" });
    expect(link).not.toHaveBeenCalled();
    expect(text).toMatch(
      /^Slack is already connected as ada@example\.com\. Its tools are in your tool list/
    );
  });

  it("is still linked from an app chat", async () => {
    const { text } = await call(
      "connect_connector",
      { service: "slack" },
      "ui-session"
    );
    expect(link).toHaveBeenCalledWith("abacus-slack", "ui-session");
    expect(account).not.toHaveBeenCalled();
    expect(text).toContain("https://apps.example/connect?service=slack&r=req");
  });
});

describe("a hosted computer that requires a session", () => {
  const strict = (): McpAgentToolsServer =>
    new McpAgentToolsServer({
      skillsService: {} as never,
      enabledToolsets: () => new Set(["connectors", "todo"]),
      workspacePath: () => null,
      requireSession: () => true,
      knownSession: (session: string) => session === "live",
    } as never);

  it("lists nothing and runs nothing for a call with no session or an unknown one", async () => {
    for (const session of [undefined, "stranger"]) {
      expect(
        (
          strict() as unknown as {
            listTools: (s?: string) => McpToolListing[];
          }
        ).listTools(session)
      ).toEqual([]);
      const result = (await strict().executeTool(
        "todo",
        { action: "list" },
        session
      )) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe(
        "This call names no session here, so no tool runs."
      );
    }
    expect(
      (
        strict() as unknown as { listTools: (s?: string) => McpToolListing[] }
      ).listTools("live").length
    ).toBeGreaterThan(0);
  });
});

describe("disconnect_connector on the phone", () => {
  it("never switches a chat app off, and says nothing changed", async () => {
    const { text } = await call("disconnect_connector", {
      service: "whatsapp",
    });
    expect(text).toBe(
      "WhatsApp cannot be disconnected from WhatsApp, and nothing was changed. Say so plainly."
    );
    expect(disablePlatform).not.toHaveBeenCalled();
  });

  it("disconnects an account connector, and says so only once it is done", async () => {
    statuses = { "abacus-slack": { state: "connected" } } as never;
    const { text } = await call("disconnect_connector", { service: "slack" });
    expect(disconnect).toHaveBeenCalledWith("abacus-slack");
    expect(text).toMatch(/^Slack is disconnected\./);
  });
});

describe("paid-plan capabilities", () => {
  const BASIC_FIRST_MONTH: BillingPlan = {
    current: {
      planName: "Free",
      creditsRemaining: 1_000,
      creditsGranted: 2_000,
      freeTierExpiresAt: null,
    },
    plans: [],
    upgrades: [
      {
        plan: "basic",
        planName: "Basic",
        priceText: "$10/mo",
        firstMonthPriceCents: 700,
        priceCents: 1_000,
        percentOff: 30,
        features: ["Top models", "Image and video generation"],
        url: "https://upgrade.example/basic",
      },
    ],
    topUpUrl: null,
    upgradeInMobileApp: false,
  };

  const planServer = (
    tier: "free" | "basic" | "unknown",
    toolsets: string[] = ["todo"],
    options: { bot?: boolean; appBotChat?: boolean } = {}
  ) =>
    new McpAgentToolsServer({
      skillsService: {} as never,
      enabledToolsets: () => new Set(toolsets),
      planTier: () => tier,
      workspacePath: () => null,
      channelForSession: (session: string) =>
        session === PHONE ? WHATSAPP_CHANNEL : null,
      isUnattended: (session: string) => session === "routine-run",
      ...(options.bot === true
        ? {
            botIdForSession: () => "bot-1",
            isAppBotChat: () => options.appBotChat === true,
          }
        : {}),
    } as never);

  const listed = (server: McpAgentToolsServer, session = "ui-session") =>
    (
      server as unknown as { listTools: (s?: string) => McpToolListing[] }
    ).listTools(session);

  const featureEnum = (tool: McpToolListing | undefined): unknown =>
    (
      tool?.inputSchema as
        | { properties: { feature: { enum: string[] } } }
        | undefined
    )?.properties.feature.enum;

  const callOn = async (
    server: McpAgentToolsServer,
    feature: string,
    session = "ui-session"
  ) => {
    const result = (await server.executeTool(
      "paid_feature",
      { feature },
      session
    )) as { content: Array<{ text?: string }>; isError?: boolean };
    return {
      text: result.content.map((part) => part.text ?? "").join("\n"),
      isError: result.isError === true,
    };
  };

  it("tells a free account's model that video, image and speech come with the paid plans", () => {
    mediaKeys.set("ABACUS_API_KEY", "key");
    const tools = listed(planServer("free"));
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain("video_generate");
    expect(names).not.toContain("image_generate");
    const tool = tools.find((entry) => entry.name === "paid_feature");
    expect(tool?.description).toMatch(
      /video generation, image generation, and text to speech/i
    );
    expect(tool?.description).toMatch(/Never tell the user you cannot/);
    expect(featureEnum(tool)).toEqual(["video_gen", "image_gen", "tts"]);
  });

  it("answers a free account's video ask with Basic, its price and the card, never a refusal", async () => {
    mediaKeys.set("ABACUS_API_KEY", "key");
    billingPlan.mockResolvedValue(BASIC_FIRST_MONTH);
    const { text, isError } = await callOn(planServer("free"), "video_gen");
    expect(isError).toBe(false);
    expect(billingPlan).toHaveBeenCalledWith(false);
    expect(text).toMatch(/Basic, \$7 for the first month \(30% off/);
    expect(text).toContain("Image and video generation");
    expect(text).toMatch(/Abacus AI Agent on the web, not in this app/);
    expect(text).toMatch(/Upgrade card under your reply/);
    expect(text).not.toContain("https://upgrade.example/basic");
    expect(text).toMatch(/Never say you cannot do it/);
  });

  it("gives the upgrade link where no card can show: a bot answering in a chat app", async () => {
    mediaKeys.set("ABACUS_API_KEY", "key");
    billingPlan.mockResolvedValue(BASIC_FIRST_MONTH);
    const { text } = await callOn(
      planServer("free", ["todo"], { bot: true }),
      "image_gen"
    );
    expect(billingPlan).toHaveBeenCalledWith(true);
    expect(text).toContain("Their upgrade link: https://upgrade.example/basic");
    expect(text).toMatch(/in this app once they upgrade/);
  });

  it("leaves a free account the real tool when it has one: a toggle on and a provider to run it", () => {
    mediaKeys.set("FAL_KEY", "key");
    const tools = listed(planServer("free", ["video_gen"]));
    expect(tools.map((tool) => tool.name)).toContain("video_generate");
    const tool = tools.find((entry) => entry.name === "paid_feature");
    expect(featureEnum(tool)).toEqual(["image_gen", "tts"]);
  });

  it("gives a paid account the real image and speech tools, and no offer for them", () => {
    mediaKeys.set("ABACUS_API_KEY", "key");
    const tools = listed(planServer("basic", ["image_gen", "tts"]));
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["image_generate", "text_to_speech"])
    );
    const tool = tools.find((entry) => entry.name === "paid_feature");
    expect(featureEnum(tool)).toEqual(["video_gen"]);
  });

  it("points a paid account without a video provider to the web, with no upgrade", async () => {
    mediaKeys.set("ABACUS_API_KEY", "key");
    const { text } = await callOn(
      planServer("basic", ["image_gen", "tts"]),
      "video_gen"
    );
    expect(billingPlan).not.toHaveBeenCalled();
    expect(text).toMatch(/^Their plan includes video generation/);
    expect(text).toMatch(/Abacus AI Agent on the web/);
    expect(text).toMatch(/Never say you cannot do it/);
  });

  it("offers nothing while the plan is unread, nor to a paid account with every capability", () => {
    mediaKeys.set("ABACUS_API_KEY", "key");
    mediaKeys.set("BFL_API_KEY", "key");
    expect(
      listed(planServer("unknown")).map((tool) => tool.name)
    ).not.toContain("paid_feature");
    expect(
      listed(planServer("basic", ["image_gen", "tts", "video_gen"])).map(
        (tool) => tool.name
      )
    ).not.toContain("paid_feature");
  });

  it("never reaches the phone or a routine nobody is watching", async () => {
    mediaKeys.set("ABACUS_API_KEY", "key");
    const server = planServer("free");
    expect(listed(server, PHONE).map((tool) => tool.name)).not.toContain(
      "paid_feature"
    );
    expect(
      listed(server, "routine-run").map((tool) => tool.name)
    ).not.toContain("paid_feature");
    expect(await callOn(server, "video_gen", PHONE)).toEqual({
      text: "Unknown tool: paid_feature",
      isError: true,
    });
    expect((await callOn(server, "video_gen", "routine-run")).isError).toBe(
      true
    );
    expect(billingPlan).not.toHaveBeenCalled();
  });
});
