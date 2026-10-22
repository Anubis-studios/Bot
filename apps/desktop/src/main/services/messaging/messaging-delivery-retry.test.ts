import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
/**
 * A reply that fails to deliver is retried, and a failure that survives the
 * retries is recorded, never dropped. One console line was all a failed
 * delivery used to leave: the sender chat showed the reply as sent, the
 * recipient got nothing, and nobody knew. What still fails is kept and tried
 * again later, and given up on only with the user told.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({ outbox: [] as unknown[] }));

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readStoredMessageLog: () => [],
  writeStoredMessageLog: () => {},
  readStoredOutbox: () => stored.outbox,
  writeStoredOutbox: (entries: unknown[]) => {
    stored.outbox = [...entries];
  },
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

const service = (
  sendText: (chatId: string, text: string) => Promise<void>,
  selfChatId?: string
): InstanceType<typeof MessagingGatewayService> => {
  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);
  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "whatsapp",
    {
      id: "whatsapp",
      start: async () => {},
      stop: async () => {},
      sendText,
      selfChatId: () => selfChatId ?? null,
    }
  );
  return gateway;
};

const send = (
  gateway: InstanceType<typeof MessagingGatewayService>
): Promise<void> =>
  (
    gateway as unknown as {
      safeSend: (
        platformId: MessagingPlatformId,
        chatId: string,
        text: string
      ) => Promise<void>;
    }
  ).safeSend("whatsapp", "School friendsss", "Hey! How's it going?");

const loggedIn = (
  gateway: InstanceType<typeof MessagingGatewayService>
): Array<{ text: string; direction: string }> =>
  (
    gateway as unknown as {
      messageLog: Array<{ text: string; direction: string }>;
    }
  ).messageLog;

beforeEach(() => {
  vi.useFakeTimers();
  stored.outbox = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("auto-reply delivery", () => {
  it("retries a failed send and records the delivery, not the failure", async () => {
    let attempts = 0;
    const gateway = service(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("stale page");
    });

    const done = send(gateway);
    await vi.advanceTimersByTimeAsync(16_000);
    await done;

    expect(attempts).toBe(2);
    // One row, the words that went out: the traffic view and
    // read_chat_messages used to show only the other side of a conversation.
    const rows = loggedIn(gateway);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.direction).toBe("out");
    expect(rows[0]?.text).not.toContain("[NOT DELIVERED]");
  });

  it("records a delivery that failed every attempt", async () => {
    let attempts = 0;
    const gateway = service(async () => {
      attempts += 1;
      throw new Error("the chat did not load");
    });

    const done = send(gateway);
    await vi.advanceTimersByTimeAsync(80_000);
    await done;

    expect(attempts).toBe(3);
    const rows = loggedIn(gateway);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toContain("[NOT DELIVERED]");
    expect(rows[0]?.text).toContain("the chat did not load");
  });
});

describe("a message that still could not go", () => {
  it("is kept on disk and goes on a later try", async () => {
    let down = true;
    const sent: string[] = [];
    const gateway = service(async (_chatId, text) => {
      if (down) throw new Error("offline");
      sent.push(text);
    });

    const done = send(gateway);
    await vi.advanceTimersByTimeAsync(80_000);
    await done;
    expect(stored.outbox).toHaveLength(1);

    down = false;
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(sent).toEqual(["Hey! How's it going?"]);
    expect(stored.outbox).toEqual([]);
    expect(loggedIn(gateway).at(-1)?.text).toBe("Hey! How's it going?");
  });

  it("is tried again when its platform connects, without waiting", async () => {
    let down = true;
    const sent: string[] = [];
    const gateway = service(async (_chatId, text) => {
      if (down) throw new Error("offline");
      sent.push(text);
    });
    const done = send(gateway);
    await vi.advanceTimersByTimeAsync(80_000);
    await done;

    down = false;
    (
      gateway as unknown as {
        setState: (id: string, state: string) => void;
      }
    ).setState("whatsapp", "connected");
    await vi.advanceTimersByTimeAsync(10);

    expect(sent).toEqual(["Hey! How's it going?"]);
  });

  it("is given up on after the last try, and the user's own chat is told", async () => {
    const sent: string[] = [];
    const gateway = service(async (chatId, text) => {
      if (chatId !== "me@self") throw new Error("the chat did not load");
      sent.push(text);
    }, "me@self");

    const done = send(gateway);
    await vi.advanceTimersByTimeAsync(80_000);
    await done;
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30 * 60_000 + 1_000);

    expect(stored.outbox).toEqual([]);
    expect(sent).toEqual(["A message to someone could not be delivered."]);
  });
});
