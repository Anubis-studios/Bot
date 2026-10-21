import type {
  MessagingPlatformId,
  SelfLanePlatform,
} from "@abacus-ai/contract/messaging";
/**
 * WHICH bot answers depends on who is talking. The user's own chat routes to
 * that app's home bot; everyone else routes to the general auto-reply bot.
 * One shared id used to send a WhatsApp group's auto-reply conversations
 * into the user's personal Telegram bot.
 */
import { describe, expect, it, vi } from "vitest";

const settings = {
  gatewayEnabled: true,
  autoApproveTools: true,
  respondToInbound: true,
  workspaceId: "ws" as string | null,
  botId: null as string | null,
  autoReplyBootstrapped: true,
};

/** The home bot per lane, as the bot service would answer. */
let homes: Partial<Record<SelfLanePlatform, string>> = {};

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readGatewaySettings: () => ({ ...settings }),
  saveGatewaySettings: (patch: Partial<typeof settings>) => {
    Object.assign(settings, patch);
  },
  isPlatformEnabled: (id: MessagingPlatformId) =>
    id === "whatsapp" || id === "abacus_discord",
  isPlatformConfigured: (id: MessagingPlatformId) =>
    id === "whatsapp" || id === "abacus_discord",
  approvedUserIds: () => new Set(["ME", "GROUP"]),
  findPairing: () => null,
  recordPairingRequest: () => {},
  approvePairing: () => {},
  listPairing: () => [],
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

const harness = (): {
  botsOpened: string[];
  gatewaySessions: number;
  inbound: (
    userId: string,
    text: string,
    platform?: MessagingPlatformId
  ) => Promise<void>;
} => {
  const botsOpened: string[] = [];
  const state = { gatewaySessions: 0 };

  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => {
      state.gatewaySessions += 1;
      return { id: `session-${state.gatewaySessions}` } as never;
    },
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
    homeBots: {
      get: (lane: SelfLanePlatform) => homes[lane] ?? null,
      set: () => {},
      ensure: (lane: SelfLanePlatform) => homes[lane] ?? null,
    },
    openBotChat: async (botId: string) => {
      botsOpened.push(botId);
      return { botId, workspaceId: "ws-bot", sessionId: `chat-${botId}` };
    },
  } as never);

  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "whatsapp",
    {
      id: "whatsapp",
      start: async () => {},
      stop: async () => {},
      sendText: async () => {},
      selfChatId: () => "ME",
    }
  );
  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "abacus_discord",
    {
      id: "abacus_discord",
      start: async () => {},
      stop: async () => {},
      sendText: async () => {},
      selfChatId: () => "me",
    }
  );

  const internals = gateway as unknown as {
    handleInbound: (
      id: MessagingPlatformId,
      m: Record<string, unknown>
    ) => Promise<void>;
  };

  return {
    botsOpened,
    get gatewaySessions() {
      return state.gatewaySessions;
    },
    inbound: (userId: string, text: string, platform = "whatsapp") =>
      internals.handleInbound(platform, {
        userId,
        userName: userId,
        chatId: userId,
        text,
      }),
  };
};

describe("who answers whom", () => {
  it("sends the user's own chat to the app's home bot, never the general one", async () => {
    homes = { whatsapp: "home-bot" };
    settings.botId = "general-bot";

    const h = harness();
    await h.inbound("ME", "hi");

    expect(h.botsOpened).toEqual(["home-bot"]);
  });

  it("sends a group to the general bot, never the home bot", async () => {
    homes = { whatsapp: "home-bot" };
    settings.botId = "general-bot";

    const h = harness();
    await h.inbound("GROUP", "Hi @Alex Rivera");

    expect(h.botsOpened).toEqual(["general-bot"]);
  });

  it("keeps a group away from the home bot when no general bot is picked", async () => {
    // The field case: only the self lane's bot existed, and the group's
    // auto-reply conversations were filed under the user's personal bot.
    // With no general bot, a group gets a gateway session.
    homes = { whatsapp: "home-bot" };
    settings.botId = null;

    const h = harness();
    await h.inbound("GROUP", "Hi @Alex Rivera");

    expect(h.botsOpened).toEqual([]);
    expect(h.gatewaySessions).toBe(1);
  });

  it("sends the Abacus AI Discord DM to Discord's home bot, never WhatsApp's", async () => {
    homes = { whatsapp: "home-bot", abacus_discord: "discord-bot" };
    settings.botId = "general-bot";

    const h = harness();
    await h.inbound("me", "hey", "abacus_discord");

    expect(h.botsOpened).toEqual(["discord-bot"]);
  });

  it("never lets the self chat fall through to another lane's bot or the general one", async () => {
    // No home bot to be had for Discord (none could be made): the DM gets a
    // plain gateway session, not WhatsApp's bot nor the general bot, which
    // is for other people.
    homes = { whatsapp: "home-bot" };
    settings.botId = "general-bot";

    const h = harness();
    await h.inbound("me", "hey", "abacus_discord");

    expect(h.botsOpened).toEqual([]);
    expect(h.gatewaySessions).toBe(1);
  });
});
