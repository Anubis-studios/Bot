/**
 * MCP, end to end: a real server on loopback, the real client, a real session.
 *
 * `mcp/client.ts` is the entire MCP implementation and was covered only by a
 * naming unit test, so nothing exercised the handshake, discovery, a tool call,
 * or what a refresh does. The refresh is the interesting one: it is what the
 * desktop's "reconnect" button runs, and the commonest reason to press it is a
 * server that was not there a moment ago.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeMcpServer,
  mcpConfig,
} from "@abacus-ai/test-support/fake-mcp-server";
import {
  FakeProvider,
  fakeProviderConfig,
} from "@abacus-ai/test-support/fake-provider";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BATCH_READ_GUIDELINES } from "../extensions/batch-read-tool.js";
import { BATCH_EDIT_GUIDELINES } from "../extensions/edit-tool.js";
import { IDENTITY_PROMPT } from "../persona.js";
import type { DesktopEvent } from "../protocol.js";
import { AbacusBotSession } from "../session.js";
import { McpClient, type McpTransport } from "./client.js";
import { buildMcpToolDefinitions } from "./tools.js";

let provider: FakeProvider;
let home: string;
let configPath: string;

/** A session pointed at the fake model, with everything it emitted. */
class Harness {
  readonly events: DesktopEvent[] = [];
  readonly session: AbacusBotSession;
  readonly cwd: string;

  constructor() {
    this.cwd = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-mcp-"));
    this.session = new AbacusBotSession({
      cwd: this.cwd,
      mode: "yolo",
      emit: (event) => this.events.push(event),
    });
  }

  get servers(): Array<{ name: string; status: string; toolCount: number }> {
    const last = [...this.events]
      .reverse()
      .find(
        (event): event is Extract<DesktopEvent, { type: "mcp_servers" }> =>
          event.type === "mcp_servers"
      );

    return last?.servers ?? [];
  }

  dispose(): void {
    this.session.dispose();
    fs.rmSync(this.cwd, { recursive: true, force: true });
  }
}

let harnesses: Harness[] = [];
let servers: FakeMcpServer[] = [];

function session(): Harness {
  const harness = new Harness();

  harnesses.push(harness);

  return harness;
}

async function mcpServer(
  tools: Parameters<typeof FakeMcpServer.start>[0]
): Promise<FakeMcpServer> {
  const server = await FakeMcpServer.start(tools);

  servers.push(server);

  return server;
}

/** The tool names the model was offered on the most recent request. */
function offeredTools(): string[] {
  return provider.calls.at(-1)?.tools ?? [];
}

/** One request's system prompt, as sent. */
function systemPromptOf(call: {
  messages: Array<{ role: string; content: unknown }>;
}): string {
  return call.messages
    .filter((message) => message.role === "system")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content)
    )
    .join("\n");
}

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-mcp-home-"));
  configPath = path.join(home, "mcp.json");
  fs.writeFileSync(
    path.join(home, "config.json"),
    fakeProviderConfig(provider),
    "utf8"
  );
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_MCP_CONFIG = configPath;
}, 60_000);

afterAll(async () => {
  await provider?.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ABACUSAI_BOT_HOME;
  delete process.env.ABACUSAI_BOT_MCP_CONFIG;
});

afterEach(async () => {
  for (const harness of harnesses) harness.dispose();
  harnesses = [];
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
  provider.calls.length = 0;
  provider.script(() => ({ say: "ok" }));
});

describe("connecting", () => {
  it("handshakes, discovers the tools, and reports the server", async () => {
    const server = await mcpServer([{ name: "lookup" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();

    expect(harness.servers).toEqual([
      expect.objectContaining({
        name: "docs",
        status: "connected",
        toolCount: 1,
      }),
    ]);
  });

  it("offers the tool to the model under its server-qualified name", async () => {
    const server = await mcpServer([{ name: "lookup" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.send("hello");

    // A user server's `lookup` becomes `docs_lookup`, so two servers offering
    // the same name stay distinct.
    expect(offeredTools()).toContain("docs_lookup");
  });

  it("does not take the gateway's GitHub tools: gh on the user's own token is the path", async () => {
    const server = await mcpServer([
      { name: "Gmail_Tool" },
      { name: "Git_Tool" },
      { name: "Github_Tool" },
    ]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ "abacus-connectors": { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.send("hello");

    const offered = offeredTools();
    expect(offered).toContain("abacus-connectors_Gmail_Tool");
    expect(offered).not.toContain("abacus-connectors_Git_Tool");
    expect(offered).not.toContain("abacus-connectors_Github_Tool");
  });

  it("tells the model it is connected, so it does not have to guess", async () => {
    const server = await mcpServer([{ name: "goto" }, { name: "click" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ playwright: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.send("are you connected to playwright?");

    // Having the tools was never enough: asked by name, the model said no.
    const system = provider.calls
      .at(-1)
      ?.messages.filter((message) => message.role === "system")
      .map((message) => JSON.stringify(message.content))
      .join("\n");

    expect(system).toContain("playwright");
    expect(system).toContain("tools named `playwright_*`");
  });

  it("leaves a built-in server's names alone", async () => {
    const server = await mcpServer([{ name: "present_deliverable" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ "agent-tools": { url: server.url, isBuiltin: true } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.send("hello");

    // Every component's hand-off text says `present_deliverable`; prefixing it
    // made the name in all of them wrong.
    expect(offeredTools()).toContain("present_deliverable");
  });

  it("calls the tool and hands the result back", async () => {
    const server = await mcpServer([
      { name: "lookup", reply: (args) => `looked up ${String(args.q)}` },
    ]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    provider.script((call, index) =>
      index === 0 && call.tools.includes("docs_lookup")
        ? { call: { name: "docs_lookup", args: { q: "widgets" } } }
        : { say: "done" }
    );

    await harness.session.start();
    await harness.session.send("look something up");

    expect(server.calls).toEqual([{ name: "lookup", args: { q: "widgets" } }]);
  });

  it("stops a call that outlives its budget and lets the turn go on", async () => {
    // A connector that never answers used to hold the turn for the
    // transport's 15 minutes; the model now hears it failed, at the budget.
    const asked: Array<number | undefined> = [];
    const transport: McpTransport = {
      request: async (method, _params, timeoutMs) => {
        if (method === "initialize") return {};
        if (method === "tools/list")
          return { tools: [{ name: "Gmail_Tool", inputSchema: {} }] };
        asked.push(timeoutMs);
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
      notify: async () => {},
      close: () => {},
    } as McpTransport;
    const client = await McpClient.connect("abacus-connectors", transport);
    const [tool] = buildMcpToolDefinitions(() => ({
      clients: [client],
      statuses: [],
      routes: new Map([
        ["abacus-connectors_Gmail_Tool", { client, toolName: "Gmail_Tool" }],
      ]),
      tools: [
        { name: "abacus-connectors_Gmail_Tool", description: "", schema: {} },
      ],
    }));

    const result = await tool!.execute("call-1", {});

    expect(asked).toEqual([90_000]);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        "did not answer within 90s, so the call was stopped"
      ),
    });
  });

  it("reports an unreachable server without taking the session down", async () => {
    // One unreachable server must never stop the agent starting: otherwise
    // the whole session dies because a simulator was not running.
    fs.writeFileSync(
      configPath,
      mcpConfig({ dead: { url: "http://127.0.0.1:1/mcp" } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();

    expect(harness.servers).toEqual([
      expect.objectContaining({ name: "dead", status: "error" }),
    ]);
    expect(harness.events.some((event) => event.type === "ready")).toBe(true);
  });

  it("skips a server the user disabled", async () => {
    const server = await mcpServer([{ name: "lookup" }]);

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { docs: { url: server.url, disabled: true } },
      }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.send("hello");

    expect(harness.servers).toEqual([
      expect.objectContaining({ name: "docs", status: "disconnected" }),
    ]);
    expect(offeredTools()).not.toContain("docs_lookup");
  });
});

describe("refreshing", () => {
  it("picks up a server that was not there when the session started", async () => {
    // The commonest reason to press reconnect: the server was down, or was
    // added a moment ago. The roster updated and the model's tool list did
    // not, so the panel said "connected, 1 tool" about a tool nothing could
    // call.
    fs.writeFileSync(configPath, mcpConfig({}), "utf8");

    const harness = session();

    await harness.session.start();

    const added = await mcpServer([{ name: "lookup" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: added.url } }),
      "utf8"
    );
    await harness.session.refreshMcp();
    await harness.session.send("hello");

    expect(harness.servers).toEqual([
      expect.objectContaining({ name: "docs", toolCount: 1 }),
    ]);
    expect(offeredTools()).toContain("docs_lookup");
  });

  it("picks up a tool a connected server gained", async () => {
    const server = await mcpServer([{ name: "lookup" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();

    server.setTools([{ name: "lookup" }, { name: "search" }]);
    await harness.session.refreshMcp();
    await harness.session.send("hello");

    expect(offeredTools()).toContain("docs_search");
  });

  it("never changes the tools under a running run: a refresh landing mid-turn applies at the turn's end, which continues with the new tools", async () => {
    // A refresh that lands inside a turn (one main gave up waiting on, or a
    // server coming up late): the run in flight keeps the tools it started
    // with. At the turn's end the change applies, additions and removals
    // both, and since it adds a tool the turn continues once, naming it.
    let harness: Harness | null = null;
    let refreshed: Promise<void> = Promise.resolve();
    const server = await mcpServer([
      {
        name: "connect",
        reply: () => {
          server.setTools([
            { name: "connect", reply: () => "connected" },
            { name: "Slack_Tool", reply: () => "sent" },
          ]);
          refreshed = new Promise((resolve) => {
            setTimeout(
              () => void harness!.session.refreshMcp().then(resolve),
              0
            );
          });
          return "Slack is connected.";
        },
      },
      { name: "search" },
    ]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    harness = session();
    await harness.session.start();
    provider.script(async (_call, index) => {
      if (index === 0) return { call: { name: "docs_connect", args: {} } };
      if (index === 1) {
        await refreshed;
        return { say: "I cannot send that." };
      }
      return { say: "sent" };
    });
    await harness.session.send("connect slack and dm hi");

    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[1]?.tools).toContain("docs_search");
    expect(provider.calls[1]?.tools).not.toContain("docs_Slack_Tool");
    expect(provider.calls[2]?.tools).toContain("docs_Slack_Tool");
    expect(provider.calls[2]?.tools).not.toContain("docs_search");
    expect(provider.calls[2]?.userText.join("\n")).toMatch(
      /became available: docs_Slack_Tool/
    );
  });

  it("reaches the model after a roster-change reload: mid-turn in the continuation, the next turn, and after a reset, always under our prompt", async () => {
    // The production sequence: a connector added between turns rebuilds the
    // prompt (a loader reload), then another tool lands mid-turn. A reload
    // used to move the tool handle to a runtime the session never reads, so
    // the mid-turn tool was registered nowhere and never retried.
    let harness: Harness | null = null;
    let refreshed: Promise<void> = Promise.resolve();
    const chat = await mcpServer([{ name: "post", reply: () => "posted" }]);
    const docs = await mcpServer([
      {
        name: "connect",
        reply: () => {
          chat.setTools([
            { name: "post", reply: () => "posted" },
            { name: "react", reply: () => "reacted" },
          ]);
          refreshed = new Promise((resolve) => {
            setTimeout(
              () => void harness!.session.refreshMcp().then(resolve),
              0
            );
          });
          return "Connected.";
        },
      },
    ]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: docs.url } }),
      "utf8"
    );
    harness = session();
    await harness.session.start();
    await harness.session.send("one");
    const turnOne = provider.calls.length;

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: docs.url }, chat: { url: chat.url } }),
      "utf8"
    );
    await harness.session.refreshMcp();
    provider.script(async (_call, index) => {
      if (index === turnOne)
        return { call: { name: "docs_connect", args: {} } };
      if (index === turnOne + 1) {
        await refreshed;
        return { say: "No react tool here." };
      }
      return { say: "done" };
    });
    await harness.session.send("two");

    const turnTwo = provider.calls.slice(turnOne);
    expect(turnTwo).toHaveLength(3);
    expect(turnTwo[0]?.tools).toContain("chat_post");
    expect(turnTwo[1]?.tools).not.toContain("chat_react");
    expect(turnTwo[2]?.userText.join("\n")).toMatch(
      /became available: chat_react/
    );
    expect(turnTwo[2]?.tools).toContain("chat_react");

    await harness.session.send("three");
    const turnThree = provider.calls.at(-1)!;
    expect(turnThree.tools).toContain("chat_react");

    // Neither a tool-count-only change nor a mid-turn arrival touches the
    // prompt, and so its cache.
    for (const call of [...turnTwo, turnThree])
      expect(systemPromptOf(call)).toBe(systemPromptOf(turnTwo[0]!));

    await harness.session.resetConversation();
    await harness.session.send("four");
    expect(offeredTools()).toContain("chat_react");

    for (const call of provider.calls) {
      const system = systemPromptOf(call);
      expect(system).toContain(IDENTITY_PROMPT.split("\n")[0]);
      // Our tools' guidelines, which pi shows only in its own default prompt.
      expect(system).toContain(BATCH_READ_GUIDELINES[0]);
      expect(system).toContain(BATCH_EDIT_GUIDELINES[0]);
      expect(system).not.toMatch(/inside pi|Pi documentation/);
    }
  });

  it("keeps routing the tools it already had", async () => {
    const server = await mcpServer([
      { name: "lookup", reply: () => "still here" },
    ]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.refreshMcp();

    provider.script((call, index) =>
      index === 0 && call.tools.includes("docs_lookup")
        ? { call: { name: "docs_lookup", args: {} } }
        : { say: "done" }
    );

    await harness.session.send("look something up");

    // The refresh closes the old clients, so a tool holding the old route
    // would be calling a closed connection.
    expect(server.calls).toHaveLength(1);
  });

  it("stops offering the tools of a server that has gone away", async () => {
    const server = await mcpServer([{ name: "lookup" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.send("hello");
    expect(offeredTools()).toContain("docs_lookup");

    fs.writeFileSync(configPath, mcpConfig({}), "utf8");
    await harness.session.refreshMcp();
    await harness.session.send("look something up");

    // pi cannot unregister a tool; the model must still never see one whose
    // server is gone.
    expect(offeredTools()).not.toContain("docs_lookup");
  });

  it("drops a tool its server stopped listing, and offers it again when it returns", async () => {
    const server = await mcpServer([{ name: "lookup" }, { name: "search" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();

    // A connector disconnected or revoked: the gateway stops listing it.
    server.setTools([{ name: "lookup" }]);
    await harness.session.refreshMcp();
    await harness.session.send("hello");
    expect(offeredTools()).toContain("docs_lookup");
    expect(offeredTools()).not.toContain("docs_search");

    server.setTools([{ name: "lookup" }, { name: "search" }]);
    await harness.session.refreshMcp();
    await harness.session.send("again");
    expect(offeredTools()).toContain("docs_search");
  });
});

describe("the browser sub-agent", () => {
  it("is given the browser tools rather than the parent loop", async () => {
    const server = await mcpServer([
      { name: "browser_navigate" },
      { name: "lookup" },
    ]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ browser: { url: server.url, isBuiltin: true } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();
    await harness.session.send("hello");

    // A page walk is dozens of element trees the main transcript would carry
    // forever, so the parent gets `browser_task` and nothing else.
    expect(offeredTools()).toContain("browser_task");
    expect(offeredTools()).not.toContain("browser_navigate");
  });

  it("sees a browser server that only arrived on a refresh", async () => {
    const other = await mcpServer([{ name: "browser_navigate" }]);

    fs.writeFileSync(
      configPath,
      mcpConfig({ browser: { url: other.url, isBuiltin: true } }),
      "utf8"
    );

    const harness = session();

    await harness.session.start();

    other.setTools([{ name: "browser_navigate" }, { name: "browser_click" }]);
    await harness.session.refreshMcp();

    // The sub-agent's tool list used to be captured when the session started,
    // so a reconnect that added a browser tool never reached it.
    const tools = harness.session.browserToolsForTest();

    expect(tools.map((tool) => (tool as { name: string }).name)).toContain(
      "browser_click"
    );
  });
});
