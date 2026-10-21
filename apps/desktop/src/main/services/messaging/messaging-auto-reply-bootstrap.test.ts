import type {
  MessagingPlatformId,
  SelfLanePlatform,
} from "@abacus-ai/contract/messaging";
/**
 * Linking a self lane (the shared Abacus AI bots, WhatsApp's "Message
 * yourself") must leave the user with a working conversation, not a
 * dashboard of switches: the moment the link proves which chat is theirs,
 * the lane gets its home bot and that chat starts answering. Only the self
 * lane: the first cut of this feature flipped the global respondToInbound
 * switch, and a friend's WhatsApp "hi" got an auto-reply as the user the
 * moment the link finished. The bootstrap must never touch the switch that
 * governs other people.
 *
 * Which bot: the one that asked to connect the app, from its own chat;
 * onboarding's first bot for a lane linked during onboarding; otherwise the
 * template rule (homeBots.ensure). And ONCE EVER: the link callback re-fires
 * on every app start and relink, and must never move the home bot again.
 */
import { describe, expect, it, vi } from "vitest";

// A mutable in-memory settings store standing in for the config file, so the
// bootstrap's own writes are visible to its later reads.
const settings = {
  gatewayEnabled: true,
  autoApproveTools: true,
  respondToInbound: false,
  workspaceId: null as string | null,
  botId: null as string | null,
  selfBotIds: {} as Partial<Record<MessagingPlatformId, string | null>>,
  autoReplyBootstrapped: false,
  autoReplyBootstrappedFor: [] as MessagingPlatformId[],
};

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readGatewaySettings: () => ({ ...settings }),
  saveGatewaySettings: (patch: Partial<typeof settings>) => {
    // Mirror the real merge semantics for the per-platform fields.
    const { selfBotIds, autoReplyBootstrappedFor, ...rest } = patch;
    Object.assign(settings, rest);
    if (selfBotIds != null)
      settings.selfBotIds = { ...settings.selfBotIds, ...selfBotIds };
    if (autoReplyBootstrappedFor != null)
      settings.autoReplyBootstrappedFor = [
        ...new Set([
          ...settings.autoReplyBootstrappedFor,
          ...autoReplyBootstrappedFor,
        ]),
      ];
  },
  isPlatformEnabled: (id: MessagingPlatformId) =>
    id === "telegram" ||
    id === "abacus_discord" ||
    id === "abacus_telegram" ||
    id === "whatsapp",
  isPlatformConfigured: (id: MessagingPlatformId) =>
    id === "telegram" ||
    id === "abacus_discord" ||
    id === "abacus_telegram" ||
    id === "whatsapp",
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

type Callbacks = { onSelfLinked?: () => void };

/** What each lane's template rule would make: the "<lane>-agent" bot. */
const templateBot = (lane: SelfLanePlatform): string => `${lane}-agent`;

const service = (
  options: { onboarding?: boolean; now?: () => number } = {}
): {
  gateway: InstanceType<typeof MessagingGatewayService>;
  /** The same callbacks, by the platform they were built for. */
  byId: Map<MessagingPlatformId, Callbacks>;
  /** Every home-bot write, as "lane:bot", and every template fallback. */
  calls: string[];
  homes: Partial<Record<SelfLanePlatform, string>>;
  state: { onboarding: boolean };
} => {
  const byId = new Map<MessagingPlatformId, Callbacks>();
  const calls: string[] = [];
  const homes: Partial<Record<SelfLanePlatform, string>> = {};
  const state = { onboarding: options.onboarding === true };

  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
    ...(options.now != null ? { now: options.now } : {}),
    deferSelfLaneDefaults: () => state.onboarding,
    homeBots: {
      get: (lane: SelfLanePlatform) => homes[lane] ?? null,
      set: (lane: SelfLanePlatform, botId: string) => {
        calls.push(`set ${lane}:${botId}`);
        homes[lane] = botId;
      },
      ensure: (lane: SelfLanePlatform) => {
        calls.push(`ensure ${lane}`);
        homes[lane] ??= templateBot(lane);
        return homes[lane];
      },
    },
  } as never);

  const build = (
    gateway as unknown as {
      buildConnector: (id: MessagingPlatformId) => unknown;
    }
  ).buildConnector.bind(gateway);
  (
    gateway as unknown as {
      buildConnector: (id: MessagingPlatformId) => unknown;
    }
  ).buildConnector = (id: MessagingPlatformId) => {
    // Reuse the real callback wiring; the bootstrap trigger is what is
    // under test, and rebuilding it here would test the test.
    const real = build(id) as { callbacks: Callbacks };
    byId.set(id, real.callbacks);
    return {
      id,
      start: async () => {},
      stop: async () => {},
      sendText: async () => {},
      selfChatId: () => (id === "telegram" ? null : "me"),
      callbacks: real.callbacks,
    };
  };

  return { gateway, byId, calls, homes, state };
};

const linked = async (
  options?: Parameters<typeof service>[0]
): Promise<ReturnType<typeof service>> => {
  const built = service(options);
  await built.gateway.syncConnectors();
  return built;
};

const reset = (): void => {
  settings.respondToInbound = false;
  settings.botId = null;
  settings.selfBotIds = {};
  settings.autoReplyBootstrapped = false;
  settings.autoReplyBootstrappedFor = [];
};

describe("a self lane linked from settings", () => {
  it("gets the template rule's bot on first link, once ever", async () => {
    reset();
    const { byId, calls, homes } = await linked();
    const telegram = byId.get("abacus_telegram")!;
    telegram.onSelfLinked?.();

    expect(calls).toEqual(["ensure abacus_telegram"]);
    expect(homes.abacus_telegram).toBe("abacus_telegram-agent");
    // The global switch answers every chat as the user; the bootstrap must
    // leave it exactly where the user had it, and the general bot alone.
    expect(settings.botId).toBeNull();
    expect(settings.respondToInbound).toBe(false);
    expect(settings.autoReplyBootstrappedFor).toEqual(["abacus_telegram"]);

    // Restored links and relinks re-fire the callback; nothing happens.
    telegram.onSelfLinked?.();
    telegram.onSelfLinked?.();
    expect(calls).toHaveLength(1);
  });

  it("is not triggered by the user's own Telegram account linking", async () => {
    // The own-account lane reads and sends as the user; it has no self chat
    // of its own, so it sets nothing.
    reset();
    const { byId, calls } = await linked();
    byId.get("telegram")!.onSelfLinked?.();

    expect(calls).toHaveLength(0);
    expect(settings.autoReplyBootstrappedFor).toEqual([]);
  });

  it("keeps the home bot an older install already has", async () => {
    // The adopted "… AbacusAI Bot <-> You" bot counts as set.
    reset();
    const { byId, calls, homes } = await linked();
    homes.whatsapp = "bot-adopted";
    byId.get("whatsapp")!.onSelfLinked?.();

    expect(calls).toEqual([]);
    expect(homes.whatsapp).toBe("bot-adopted");
    expect(settings.autoReplyBootstrappedFor).toEqual(["whatsapp"]);
  });

  it("gives each lane its own home bot", async () => {
    reset();
    const { byId, homes } = await linked();
    byId.get("abacus_discord")!.onSelfLinked?.();
    byId.get("abacus_telegram")!.onSelfLinked?.();
    byId.get("whatsapp")!.onSelfLinked?.();

    expect(homes).toEqual({
      abacus_discord: "abacus_discord-agent",
      abacus_telegram: "abacus_telegram-agent",
      whatsapp: "whatsapp-agent",
    });
  });
});

describe("a self lane connected from a bot's own chat", () => {
  it("makes that bot the home bot", async () => {
    reset();
    const { gateway, byId, calls, homes } = await linked();
    // connect_connector in the Price Watch bot's chat, for "telegram".
    gateway.claimSelfLane("telegram", "bot-prices");
    byId.get("abacus_telegram")!.onSelfLinked?.();

    expect(calls).toEqual(["set abacus_telegram:bot-prices"]);
    expect(homes.abacus_telegram).toBe("bot-prices");
  });

  it("does not move a home bot set before, from whichever bot", async () => {
    reset();
    const { gateway, byId, homes } = await linked();
    byId.get("whatsapp")!.onSelfLinked?.();

    // Later: another bot connects WhatsApp again, and it relinks.
    gateway.claimSelfLane("whatsapp", "bot-prices");
    byId.get("whatsapp")!.onSelfLinked?.();

    expect(homes.whatsapp).toBe("whatsapp-agent");
  });

  it("lets a claim go stale", async () => {
    reset();
    let now = 1_000_000;
    const { gateway, byId, homes } = await linked({ now: () => now });
    gateway.claimSelfLane("discord", "bot-prices");
    now += 31 * 60_000;
    byId.get("abacus_discord")!.onSelfLinked?.();

    expect(homes.abacus_discord).toBe("abacus_discord-agent");
  });
});

describe("a self lane linked during onboarding", () => {
  it("waits for onboarding, then takes the template rule (onboarding's bot)", async () => {
    reset();
    const { gateway, byId, calls, homes, state } = await linked({
      onboarding: true,
    });
    byId.get("abacus_telegram")!.onSelfLinked?.();

    // Nothing yet: the bot onboarding makes does not exist so far.
    expect(calls).toEqual([]);
    expect(settings.autoReplyBootstrappedFor).toEqual([]);

    state.onboarding = false;
    gateway.settleSelfLaneDefaults();

    expect(calls).toContain("ensure abacus_telegram");
    expect(homes.abacus_telegram).toBe("abacus_telegram-agent");
    expect(settings.autoReplyBootstrappedFor).toContain("abacus_telegram");
  });
});
