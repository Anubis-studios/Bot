/**
 * `send_chat_message` with an attachment: the file must exist, fit the cap,
 * sit in the workspace outside every credential store, and go through the
 * file lane (from a copy of the checked bytes) with the message as caption.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

let dir: string;
const send = vi.fn(async () => undefined);
const staged: Array<{ name: string; bytes: string }> = [];
const sendFile = vi.fn(async (_platform: string, _to: string, file: string) => {
  staged.push({
    name: path.basename(file),
    bytes: fs.readFileSync(file, "utf8"),
  });
});

const server = (): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["messaging"]),
    workspacePath: () => dir,
    messaging: {
      runningPlatforms: () => ["whatsapp"],
      listChats: () => [],
      send,
      readMessages: async () => [],
      sendFile,
    },
  } as never);

const call = async (args: Record<string, unknown>): Promise<string> => {
  const result = await (
    server() as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>
      ) => Promise<{ content: { text?: string }[] }>;
    }
  ).executeTool("send_chat_message", args);

  return result.content.map((part) => part.text ?? "").join("\n");
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "send-file-"));
  send.mockClear();
  sendFile.mockClear();
  staged.length = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("sending a file", () => {
  it("delivers through the file lane with the message as caption", async () => {
    const file = path.join(dir, "report.pdf");
    fs.writeFileSync(file, "pdf bytes");

    const text = await call({
      platform: "whatsapp",
      to: "Baba",
      message: "the report",
      attachment_path: file,
    });

    expect(sendFile).toHaveBeenCalledWith(
      "whatsapp",
      "Baba",
      expect.not.stringContaining(dir),
      "the report"
    );
    expect(staged).toEqual([{ name: "report.pdf", bytes: "pdf bytes" }]);
    expect(send).not.toHaveBeenCalled();
    expect(text).toContain("Sent the file");
  });

  it("allows a file with no caption, but not a call with neither", async () => {
    const file = path.join(dir, "photo.jpg");
    fs.writeFileSync(file, "jpg");

    await call({ platform: "whatsapp", to: "Baba", attachment_path: file });
    expect(sendFile).toHaveBeenCalledWith(
      "whatsapp",
      "Baba",
      expect.stringMatching(/photo\.jpg$/),
      undefined
    );

    const text = await call({ platform: "whatsapp", to: "Baba" });
    expect(text).toContain("no message");
  });

  it("refuses a path that does not exist, naming it", async () => {
    const text = await call({
      platform: "whatsapp",
      to: "Baba",
      attachment_path: path.join(dir, "missing.png"),
    });

    expect(sendFile).not.toHaveBeenCalled();
    expect(text).toContain("No file at");
  });

  it("refuses a file over the cap with both sizes in the answer", async () => {
    const file = path.join(dir, "huge.bin");
    fs.writeFileSync(file, Buffer.alloc(26 * 1024 * 1024));

    const text = await call({
      platform: "whatsapp",
      to: "Baba",
      attachment_path: file,
    });

    expect(sendFile).not.toHaveBeenCalled();
    expect(text).toContain("26MB");
    expect(text).toContain("25MB");
  });

  it("refuses a file outside the workspace, sending nothing", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "send-file-out-"));
    try {
      const file = path.join(outside, "id_rsa");
      fs.writeFileSync(file, "secret");

      const text = await call({
        platform: "whatsapp",
        to: "Baba",
        attachment_path: file,
      });

      expect(sendFile).not.toHaveBeenCalled();
      expect(text).toContain("only files in the workspace");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("ignores an attachment_path a per-platform send does not declare", async () => {
    const file = path.join(dir, "report.pdf");
    fs.writeFileSync(file, "pdf bytes");

    await (
      server() as unknown as {
        executeTool: (
          name: string,
          args: Record<string, unknown>
        ) => Promise<unknown>;
      }
    ).executeTool("send_whatsapp_message", {
      to: "Baba",
      message: "hi",
      attachment_path: file,
    });

    expect(sendFile).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("whatsapp", "Baba", "hi", undefined);
  });
});
