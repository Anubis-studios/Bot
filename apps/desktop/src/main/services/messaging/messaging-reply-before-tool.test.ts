import { AgentStatus } from "@abacus-ai/contract/agent-types";
import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
/**
 * A reply the model wrapped before a tool call is still the reply.
 *
 * Text before a tool call is treated as narration and dropped, which is
 * right for "Let me check the weather", but a model that answered "Love
 * you too" inside <reply>, then filed a memory note, ended its turn with
 * nothing after the tool call, and the wrapped answer went with the
 * narration. Nothing was sent, and nothing was logged as failed.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./messaging-config-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./messaging-config-service")>();
  return {
    ...actual,
    readGatewaySettings: () => ({
      gatewayEnabled: true,
      autoApproveTools: true,
      respondToInbound: true,
      workspaceId: "ws",
    }),
    isPlatformEnabled: (id: MessagingPlatformId) => id === "discord",
    isPlatformConfigured: (id: MessagingPlatformId) => id === "discord",
    approvedUserIds: () => new Set(["U1"]),
    findPairing: () => null,
    recordPairingRequest: () => {},
    listPairing: () => [],
    readStoredMessageLog: () => [],
    writeStoredMessageLog: () => {},
  };
});

const { MessagingGatewayService } = await import("./messaging-gateway-service");

const harness = () => {
  const sent: string[] = [];
  let currentSession = "";
  let created = 0;
  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => {
      created += 1;
      currentSession = `session-${created}`;
      return { id: currentSession } as never;
    },
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);
  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "discord",
    {
      id: "discord",
      start: async () => {},
      stop: async () => {},
      sendText: async (_chatId: string, text: string) => {
        sent.push(text);
      },
    }
  );
  const internals = gateway as unknown as {
    handleInbound: (
      id: MessagingPlatformId,
      m: Record<string, unknown>
    ) => Promise<void>;
  };
  const emit = (event: Record<string, unknown>): void =>
    gateway.handleAgentEvent(currentSession, { type: "event", event } as never);
  return {
    sent,
    inbound: (text: string) =>
      internals.handleInbound("discord", {
        userId: "U1",
        userName: "S",
        chatId: "C1",
        text,
      }),
    say: (content: string, messageId?: string) =>
      emit({ type: "text_delta", content, messageId }),
    tool: () => emit({ type: "tool_call_start", toolName: "memory" }),
    idle: () => emit({ type: "status_changed", status: AgentStatus.Idle }),
  };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a reply wrapped before a tool call", () => {
  it("is sent when the turn ends with nothing after the call", async () => {
    const h = harness();
    await h.inbound("Love u");
    h.say("A warm message. <reply>Love you too ❤️</reply>", "m1");
    h.tool();
    h.idle();
    await tick();
    expect(h.sent).toEqual(["Love you too ❤️"]);
  });

  it("gives way to a reply written after the call", async () => {
    const h = harness();
    await h.inbound("weather?");
    h.say("<reply>one sec</reply>", "m1");
    h.tool();
    h.say("<reply>Sunny, 24°.</reply>", "m2");
    h.idle();
    await tick();
    expect(h.sent).toEqual(["Sunny, 24°."]);
  });

  it("still drops untagged narration before a call", async () => {
    const h = harness();
    await h.inbound("weather?");
    h.say("Let me check the weather for you.", "m1");
    h.tool();
    h.say("<reply>Sunny, 24°.</reply>", "m2");
    h.idle();
    await tick();
    expect(h.sent).toEqual(["Sunny, 24°."]);
  });

  it("does not carry a reply into the next turn", async () => {
    const h = harness();
    await h.inbound("Love u");
    h.say("<reply>Love you too</reply>", "m1");
    h.tool();
    h.idle();
    await tick();
    await h.inbound("ok");
    h.say("Noted.", "m2");
    h.idle();
    await tick();
    expect(h.sent).toEqual(["Love you too", "Noted."]);
  });
});

/**
 * Files a relayed turn hands over with present_deliverable go into the chat
 * after its words: only the user's own chat, never someone else's.
 */
const fileHarness = (owner: boolean) => {
  const sent: string[] = [];
  const files: Array<{ name: string; bytes: string; reply?: string }> = [];
  const released: string[] = [];
  let failSend = false;
  const pdf = {
    ok: true as const,
    kind: "document" as const,
    data: Buffer.from("%PDF"),
    filename: "report.pdf",
  };
  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => ({ id: "s1" }) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
    resolveMedia: (ref: string) =>
      ref === "media-0123456789abcdef0123"
        ? pdf
        : { ok: false, reason: "unknown" },
    releaseMedia: (ref: string) => {
      released.push(ref);
    },
  } as never);
  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "discord",
    {
      id: "discord",
      start: async () => {},
      stop: async () => {},
      selfChatId: () => (owner ? "U1" : null),
      fileLimits: () => ({ documentTypes: ["pdf"], documentMaxBytes: 1024 }),
      sendText: async (_chatId: string, text: string) => {
        sent.push(text);
      },
      sendFile: async (
        _chatId: string,
        filePath: string,
        _caption?: string,
        replyContext?: Record<string, string>
      ) => {
        if (failSend) throw new Error("refused");
        const { readFile } = await import("node:fs/promises");
        files.push({
          name: filePath.split(/[\\/]/).pop() ?? "",
          bytes: await readFile(filePath, "utf8"),
          reply: replyContext?.message_id,
        });
      },
    }
  );
  const internals = gateway as unknown as {
    handleInbound: (
      id: MessagingPlatformId,
      m: Record<string, unknown>
    ) => Promise<void>;
  };
  const emit = (event: Record<string, unknown>): void =>
    gateway.handleAgentEvent("s1", { type: "event", event } as never);
  return {
    gateway,
    sent,
    files,
    released,
    failNextSends: () => {
      failSend = true;
    },
    inbound: () =>
      internals.handleInbound("discord", {
        userId: "U1",
        userName: "S",
        chatId: "C1",
        text: "make me the report",
        replyContext: { message_id: "e1" },
      }),
    present: () =>
      emit({
        type: "tool_execution_complete",
        tool: { name: "agent-tools_present_deliverable", input: {} },
        result: {
          content:
            "Sending 1 item\n[media] media-0123456789abcdef0123\n[artifact] /w/report.pdf",
        },
      }),
    say: (content: string) =>
      emit({ type: "text_delta", content, messageId: "m1" }),
    idle: () => emit({ type: "status_changed", status: AgentStatus.Idle }),
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("files a turn hands to its chat", () => {
  it("go to the user's own chat after the words, as the answer to their message", async () => {
    const h = fileHarness(true);
    await h.inbound();
    expect(h.gateway.chatTurn("s1")).toEqual({
      app: "Discord",
      owner: true,
      files: { documentTypes: ["pdf"], documentMaxBytes: 1024 },
    });
    h.present();
    h.say("<reply>Here is your report.</reply>");
    h.idle();
    await settle();
    expect(h.sent).toEqual(["Here is your report."]);
    expect(h.files).toEqual([
      { name: "report.pdf", bytes: "%PDF", reply: "e1" },
    ]);
    expect(h.released).toEqual(["media-0123456789abcdef0123"]);
    expect(h.gateway.chatTurn("s1")).toBeNull();
  });

  it("name a file that did not go, instead of leaving the user waiting", async () => {
    const h = fileHarness(true);
    h.failNextSends();
    await h.inbound();
    h.present();
    h.say("<reply>Here it is.</reply>");
    h.idle();
    await settle();
    expect(h.files).toEqual([]);
    expect(h.sent[0]).toBe("Here it is.");
    expect(h.sent[1]).toContain("report.pdf");
    expect(h.sent[1]).toContain("AbacusAI Bot app");
  });

  it("never go to someone else's chat", async () => {
    const h = fileHarness(false);
    await h.inbound();
    expect(h.gateway.chatTurn("s1")).toEqual({
      app: "Discord",
      owner: false,
      files: null,
    });
    h.present();
    h.say("Here you go.");
    h.idle();
    await settle();
    expect(h.files).toEqual([]);
    expect(h.released).toEqual(["media-0123456789abcdef0123"]);
  });
});
