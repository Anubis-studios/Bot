/**
 * The shared bots' inbox is one queue per account, not one per channel.
 * With Discord and Telegram both linked, each lane's poll drained the whole
 * queue, and a Telegram message came in through whichever poll returned
 * first and was logged, routed and answered as Discord. An entry now reaches the
 * lane its channel names, whichever lane fetched it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() },
}));
vi.mock("../../bring-to-front", () => ({ parentWindow: () => undefined }));
vi.mock("../providers/abacus", () => ({ resolveAbacusApiKey: () => "key" }));
vi.mock("../providers/abacus-host", () => ({
  abacusRoutellmV1: () => "https://example.test/v1",
  abacusUserAgent: () => "test",
}));
vi.mock("./discord-web-connector", () => ({
  DISCORD_PARTITION: "persist:discord-web",
}));

const { AbacusChannelsConnector } = await import("./abacus-channels-connector");

type Delivered = { lane: string; text: string; from: string | null };
type Entry = {
  id: string;
  ts: number;
  channel: string;
  sender: string | null;
  text: string;
};
type Lane = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  route: (entry: Entry) => void;
};

// Every call answers "available, nothing linked": start() registers the lane
// and its poll then idles on the pairing interval instead of the inbox.
const requests: Array<Record<string, unknown>> = [];
globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
  requests.push(JSON.parse(String(init?.body ?? "{}")));
  return new Response(
    JSON.stringify({ available: ["discord", "telegram"], channels: {} }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}) as unknown as typeof fetch;

const started: Lane[] = [];
const lane = async (
  channel: "discord" | "telegram",
  delivered: Delivered[],
  logs: string[]
): Promise<Lane> => {
  const connector = new AbacusChannelsConnector(
    {
      onMessage: (message) =>
        delivered.push({
          lane: channel,
          text: message.text,
          from: message.userName,
        }),
      onState: () => {},
      onLog: (line) => logs.push(line),
    },
    channel
  ) as unknown as Lane;
  await connector.start();
  started.push(connector);
  return connector;
};

afterEach(async () => {
  for (const connector of started.splice(0)) await connector.stop();
});

const entry = (channel: string, text: string): Entry => ({
  id: `${channel}-${text}`,
  ts: 1,
  channel,
  sender: "S",
  text,
});

describe("an inbox entry", () => {
  it("reaches the lane its channel names, whichever lane fetched it", async () => {
    const delivered: Delivered[] = [];
    const logs: string[] = [];
    const discord = await lane("discord", delivered, logs);
    await lane("telegram", delivered, logs);

    discord.route(entry("telegram", "Love u"));
    discord.route(entry("discord", "Hey"));

    expect(delivered).toEqual([
      { lane: "telegram", text: "Love u", from: "S" },
      { lane: "discord", text: "Hey", from: "S" },
    ]);
    expect(logs.filter((line) => line.includes("no telegram lane"))).toEqual(
      []
    );
  });

  it("is delivered by the fetching lane, and said so, when its lane is not running", async () => {
    const delivered: Delivered[] = [];
    const logs: string[] = [];
    const discord = await lane("discord", delivered, logs);

    discord.route(entry("telegram", "Love u"));

    expect(delivered).toEqual([{ lane: "discord", text: "Love u", from: "S" }]);
    expect(logs.some((line) => line.includes("no telegram lane running"))).toBe(
      true
    );
  });

  it("stays with the fetching lane when the entry names no channel", async () => {
    const delivered: Delivered[] = [];
    const discord = await lane("discord", delivered, []);
    await lane("telegram", delivered, []);

    discord.route({ ...entry("discord", "Hey"), channel: "" });

    expect(delivered).toEqual([{ lane: "discord", text: "Hey", from: "S" }]);
  });
});

/**
 * A file answer through the shared bot: sent only where the server says its
 * replies carry files, as the answer to the user's message.
 */
describe("a file answer", () => {
  const withServer = async (
    status: Record<string, unknown>,
    run: (connector: {
      fileLimits: () => unknown;
      sendFile: (
        chatId: string,
        filePath: string,
        caption?: string,
        replyContext?: Record<string, string>
      ) => Promise<void>;
    }) => Promise<void>
  ): Promise<Array<Record<string, unknown>>> => {
    const saved = globalThis.fetch;
    const calls: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push(body);
      const answer =
        body.action === "status"
          ? {
              available: ["telegram"],
              channels: { telegram: { status: "linked" } },
              ...status,
            }
          : { ok: true };
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const connector = new AbacusChannelsConnector(
      { onMessage: () => {}, onState: () => {}, onLog: () => {} },
      "telegram"
    );
    try {
      await (
        connector as unknown as { refreshStatus: () => Promise<void> }
      ).refreshStatus();
      await run(connector as never);
    } finally {
      globalThis.fetch = saved;
      await connector.stop();
    }
    return calls;
  };

  it("goes as a document reply where the server takes files", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "shared-file-"));
    const file = path.join(dir, "notes.docx");
    await writeFile(file, "PK notes");
    let limits: unknown;
    const calls = await withServer(
      {
        reply_media: {
          telegram: { image: 5, document: 16, document_types: ["docx"] },
        },
      },
      async (connector) => {
        limits = connector.fileLimits();
        await connector.sendFile("me", file, "Here", { message_id: "e1" });
      }
    );
    await rm(dir, { recursive: true, force: true });
    expect(limits).toEqual({ documentTypes: ["docx"], documentMaxBytes: 16 });
    expect(calls.at(-1)).toEqual({
      action: "reply",
      message_id: "e1",
      document_b64: Buffer.from("PK notes").toString("base64"),
      filename: "notes.docx",
      text: "Here",
    });
  });

  it("is not offered by a server whose replies carry no files", async () => {
    let limits: unknown = "unset";
    await withServer({}, async (connector) => {
      limits = connector.fileLimits();
    });
    expect(limits).toBeNull();
  });
});
