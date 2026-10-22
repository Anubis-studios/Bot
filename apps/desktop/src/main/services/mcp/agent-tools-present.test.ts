/**
 * `present_deliverable`: what actually reaches the preview pane.
 *
 * The tool takes a list; every item becomes a row of the chat's files card,
 * and only the first (the primary) goes to the preview pane. A bot's turn
 * sends nothing to the pane at all. The broadcast is stored in main until a
 * pane answers; the result claims the pane only when one answered in ~1 s.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { declaredMedia } from "@abacus-ai/agent/send-media";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MediaStore } from "../messaging/media-store";
import { PreviewTargets } from "../session/preview-targets";
import { McpAgentToolsServer } from "./mcp-agent-tools-server";

const sent = vi.fn();

vi.mock("#main/rpc/emit", () => ({
  emitHostEvent: (payload: unknown) => sent("bus", payload),
}));

const server = (extra: Record<string, unknown> = {}): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set<string>(),
    workspacePath: () => null,
    ...extra,
  } as never);

type Executable = {
  executeTool: (
    name: string,
    args: Record<string, unknown>,
    session?: string
  ) => Promise<{ content: { text?: string }[] }>;
};

/** The paths the broadcast carried, in the order they were sent. */
const present = async (
  items: { path: string; label?: string }[]
): Promise<string[]> => {
  await (
    server() as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>,
        session?: string
      ) => Promise<{ content: { text?: string }[] }>;
    }
  ).executeTool("present_deliverable", { items }, "session-1");

  return sent.mock.calls.map((call) => (call[1] as { path: string }).path);
};

beforeEach(() => {
  sent.mockReset();
});

describe("presenting URLs", () => {
  it("opens the one it was given", async () => {
    expect(await present([{ path: "http://localhost:5173" }])).toEqual([
      "http://localhost:5173",
    ]);
  });

  it("opens only the first; the rest are rows of the files card", async () => {
    const paths = await present([
      { path: "http://localhost:5173" },
      { path: "http://localhost:5174" },
      { path: "http://localhost:5175" },
    ]);

    expect(paths).toEqual(["http://localhost:5173"]);
  });
});

describe("presenting from a bot's chat", () => {
  it("opens no pane, and says the card is where the file is", async () => {
    const result = await (
      server({
        botIdForSession: (session: string) =>
          session === "bot-session" ? "bot-1" : null,
      }) as unknown as Executable
    ).executeTool(
      "present_deliverable",
      { items: [{ path: "http://localhost:5173" }] },
      "bot-session"
    );

    expect(sent).not.toHaveBeenCalled();
    const text = result.content.map((part) => part.text ?? "").join("");
    expect(text).toContain("http://localhost:5173");
    expect(text).not.toContain("preview pane");
  });
});

describe("a name the model transcribed", () => {
  it("is located by how it reads, and declared under its real name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "present-"));
    const real = path.join(
      dir,
      "Screenshot 2026-09-14 at 12.55.59\u202fAM.png"
    );
    fs.writeFileSync(real, "png");

    const result = await (server() as unknown as Executable).executeTool(
      "present_deliverable",
      {
        items: [
          { path: path.join(dir, "Screenshot 2026-09-14 at 12.55.59 AM.png") },
        ],
      },
      "session-1"
    );

    const text = result.content.map((part) => part.text ?? "").join("");
    expect(text).toContain(`[artifact] ${real}`);
    expect(text).not.toContain("Not presented");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("what the result declares", () => {
  it("is exactly the items that exist, one marker line each", async () => {
    const result = await (server() as unknown as Executable).executeTool(
      "present_deliverable",
      {
        items: [
          { path: "http://localhost:5173", label: "The app" },
          { path: "/nowhere/user@a.com_user@b.com", label: "placeholder" },
          { path: "http://localhost:4000" },
        ],
      },
      "session-1"
    );

    const text = result.content.map((part) => part.text ?? "").join("");
    const declared = text
      .split("\n")
      .filter((line) => line.startsWith("[artifact] "));
    expect(declared).toEqual([
      "[artifact] http://localhost:5173",
      "[artifact] http://localhost:4000",
    ]);
    expect(text).toContain("Not presented, because there is no file");
  });
});

describe("presenting nothing that exists", () => {
  it("opens no pane and says so", async () => {
    const result = await (
      server() as unknown as {
        executeTool: (
          name: string,
          args: Record<string, unknown>,
          session?: string
        ) => Promise<{ content: { text?: string }[] }>;
      }
    ).executeTool(
      "present_deliverable",
      { items: [{ path: "/nope/missing.pdf" }] },
      "session-1"
    );

    expect(sent).not.toHaveBeenCalled();
    expect(result.content.map((part) => part.text ?? "").join("")).toContain(
      "none of those exist"
    );
  });
});

describe("which pane it lands in", () => {
  it("names the caller's conversation, so it opens in that chat and no other", async () => {
    const key = sessionConversationKey("workspace-1", "session-1");
    await (
      server({
        conversationKeyForSession: (sessionId: string) =>
          sessionId === "session-1" ? key : null,
      }) as unknown as Executable
    ).executeTool(
      "present_deliverable",
      { items: [{ path: "http://localhost:5173" }] },
      "session-1"
    );

    expect(sent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "preview-open",
        path: "http://localhost:5173",
        conversationKey: key,
      })
    );
  });

  it("leaves the key off when the session is not known", async () => {
    await (server() as unknown as Executable).executeTool(
      "present_deliverable",
      { items: [{ path: "http://localhost:5173" }] },
      "session-1"
    );

    const payload = sent.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("conversationKey");
  });
});

describe("what the model is told about the pane", () => {
  const key = sessionConversationKey("workspace-1", "session-1");
  const run = async (
    answer: ((id: string, targets: PreviewTargets) => void) | null,
    extra: Record<string, unknown> = {},
    delay = 20
  ) => {
    const targets = new PreviewTargets();
    sent.mockImplementation((_bus, event: { id?: string }) => {
      if (answer != null && event.id != null)
        setTimeout(() => answer(event.id!, targets), delay);
    });
    const started = performance.now();
    const result = await (
      server({
        previewTargets: targets,
        conversationKeyForSession: () => key,
        ...extra,
      }) as unknown as Executable
    ).executeTool(
      "present_deliverable",
      { items: [{ path: "http://localhost:5173", label: "The app" }] },
      "session-1"
    );
    return {
      text: result.content.map((part) => part.text ?? "").join(""),
      took: performance.now() - started,
      targets,
    };
  };

  it("says it is open only once the pane reported its page drew", async () => {
    const { text, took, targets } = await run((id, t) =>
      t.handled(key, id, true)
    );
    expect(text).toContain("The app is open in the preview pane.");
    expect(took).toBeLessThan(500);
    expect(targets.pending(key)).toBeNull();
  });

  it("without an answer in ~1 s, says it opens when the user views the session, and keeps it", async () => {
    const { text, took, targets } = await run(null);
    expect(text).toContain(
      "The app opens in the preview pane when the user views this session."
    );
    expect(text).not.toContain("is open in the preview pane");
    expect(took).toBeGreaterThanOrEqual(950);
    expect(took).toBeLessThan(1_500);
    expect(targets.pending(key)).toEqual({
      id: expect.any(String),
      path: "http://localhost:5173",
    });
  });

  it("a draw that failed (or a pane that declined it) leaves only the files card", async () => {
    const { text } = await run((id, t) => t.handled(key, id, false));
    expect(text).toContain(
      "Listed in the chat as a files card the user can open."
    );
    expect(text).not.toContain("preview pane");
  });

  it("a draw slower than ~1 s gets the honest fallback, and the late answer still clears it", async () => {
    const { text, took, targets } = await run(
      (id, t) => t.handled(key, id, true),
      {},
      1_200
    );
    expect(text).toContain("when the user views this session");
    expect(text).not.toContain("is open in the preview pane");
    expect(took).toBeLessThan(1_150);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(targets.pending(key)).toBeNull();
  });

  it("a bot's turn stores and waits on nothing", async () => {
    const { took, targets } = await run(null, {
      botIdForSession: () => "bot-1",
    });
    expect(sent).not.toHaveBeenCalled();
    expect(took).toBeLessThan(500);
    expect(targets.pending(key)).toBeNull();
  });
});

describe("offer_session", () => {
  // "app" is a bot's own chat in the app, "linked" a bot that lives in a chat
  // app, "session" no bot at all.
  const server = () =>
    new McpAgentToolsServer({
      skillsService: {} as never,
      enabledToolsets: () => new Set<string>(),
      workspacePath: () => null,
      botIdForSession: (sessionId: string) =>
        sessionId === "session" ? null : "bot-1",
      isAppBotChat: (sessionId: string) => sessionId === "app",
    } as never) as unknown as {
      listTools: (session?: string) => { name: string }[];
      executeTool: (
        name: string,
        args: Record<string, unknown>,
        session?: string
      ) => Promise<{ isError?: boolean; content: { text?: string }[] }>;
    };
  const listed = (session: string) =>
    server()
      .listTools(session)
      .some((tool) => tool.name === "offer_session");

  it("is offered only in a bot's own chat in the app", () => {
    expect(listed("app")).toBe(true);
    expect(listed("linked")).toBe(false);
    expect(listed("session")).toBe(false);
  });

  it("answers the bot, and refuses a caller it is not listed for", async () => {
    const args = { title: "Landing page", prompt: "Build me a landing page" };
    const ok = await server().executeTool("offer_session", args, "app");
    expect(ok.isError).not.toBe(true);
    expect(ok.content[0]?.text).toContain("button");
    const refused = await server().executeTool("offer_session", args, "linked");
    expect(refused.isError).toBe(true);
  });
});

/**
 * A turn answering a chat app (the user's WhatsApp, the Abacus AI bot's
 * Telegram DM): files go into that chat, never to a card the phone cannot
 * open; someone else's chat gets none.
 */
describe("presenting from a turn that answers a chat app", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chat-turn-"));
  fs.writeFileSync(path.join(workspace, "notes.docx"), "PK notes");
  fs.writeFileSync(path.join(workspace, "app.py"), "print(1)");
  fs.writeFileSync(path.join(workspace, "big.pdf"), Buffer.alloc(2048));

  const chatServer = (turn: unknown, store = new MediaStore()) =>
    server({
      workspacePath: () => workspace,
      botIdForSession: () => "bot-1",
      chatTurn: () => turn,
      chatMedia: () => ({
        keep: (
          sessionId: string,
          data: Buffer,
          filename: string,
          limits: never
        ) => store.putFile(sessionId, data, filename, limits),
        screenshot: async () => ({ reason: "no browser" }),
      }),
    }) as unknown as Executable;
  const text = (result: { content: { text?: string }[] }) =>
    result.content.map((part) => part.text ?? "").join("\n");
  const limits = { documentTypes: ["docx", "py"], documentMaxBytes: 1024 };

  it("sends the files into the user's own chat, with no card and no pane", async () => {
    const store = new MediaStore();
    const result = await chatServer(
      { app: "WhatsApp", owner: true, files: limits },
      store
    ).executeTool(
      "present_deliverable",
      { items: [{ path: "notes.docx" }, { path: "app.py" }] },
      "bot-session"
    );
    const said = text(result);
    expect(said).toContain("Sending 2 items to this WhatsApp chat");
    expect(said).not.toMatch(/files card|preview pane/);
    const ids = declaredMedia(said);
    expect(ids).toHaveLength(2);
    expect(store.resolve(ids[1]!, "bot-session")).toMatchObject({
      ok: true,
      kind: "document",
      filename: "app.py",
    });
    expect(sent).not.toHaveBeenCalled();
  });

  it("says what is too big for the chat, and that it is in the app", async () => {
    const said = text(
      await chatServer({
        app: "Discord",
        owner: true,
        files: limits,
      }).executeTool(
        "present_deliverable",
        { items: [{ path: "big.pdf" }] },
        "bot-session"
      )
    );
    expect(said).toContain("Nothing was sent to the chat.");
    expect(said).toContain("larger than 0 MB");
    expect(said).toContain("in the AbacusAI Bot app on their computer");
  });

  it("sends nothing to someone else's chat, and says not to mention it", async () => {
    const said = text(
      await chatServer({
        app: "WhatsApp",
        owner: false,
        files: null,
      }).executeTool(
        "present_deliverable",
        { items: [{ path: "notes.docx" }] },
        "bot-session"
      )
    );
    expect(said).toContain("files never go to other people");
    expect(declaredMedia(said)).toEqual([]);
  });

  it("on a chat that takes no files, says the file is in the app, never its path", async () => {
    const said = text(
      await chatServer({
        app: "Telegram",
        owner: true,
        files: null,
      }).executeTool(
        "present_deliverable",
        { items: [{ path: "notes.docx" }] },
        "bot-session"
      )
    );
    expect(said).toContain("Telegram cannot take files from this app");
    expect(said).toContain("Never give a file path");
    expect(declaredMedia(said)).toEqual([]);
  });

  it("tells serve's caller the URL opens on this computer only", async () => {
    fs.mkdirSync(path.join(workspace, "site"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "site", "index.html"), "<h1>x</h1>");
    const target = chatServer({ app: "WhatsApp", owner: true, files: limits });
    const said = text(
      await target.executeTool(
        "serve",
        { action: "start", directory: "site" },
        "bot-session"
      )
    );
    await target.executeTool(
      "serve",
      { action: "stop", directory: "site" },
      "bot-session"
    );
    expect(said).toContain("opens on this computer only");
    expect(said).toContain("never give it to them");
  });
});
