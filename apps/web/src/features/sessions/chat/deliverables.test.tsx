import type { UIMessage } from "@tanstack/ai-client";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n, initI18n } from "#renderer/lib/i18n";

import {
  deliverablesAfter,
  rowEndIndex,
  sessionDeliverablesCard,
} from "./deliverables";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en-US");
});

const user = (id: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", content: "hi" }] }) as UIMessage;
const writer = (id: string, path: string): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: `c-${id}`,
        name: "write",
        arguments: JSON.stringify({ file_path: path }),
        input: { file_path: path },
        state: "complete",
        output: { text: "ok" },
      },
      {
        type: "tool-result",
        toolCallId: `c-${id}`,
        content: JSON.stringify({ text: "ok" }),
        state: "complete",
      },
    ],
  }) as unknown as UIMessage;

describe("deliverablesAfter", () => {
  const messages = [
    user("u"),
    writer("a1", "/w/report.md"),
    writer("a2", "/w/x.ts"),
  ];

  it("shows on the turn's last assistant message only", () => {
    expect(deliverablesAfter(messages, 1, false)).toBeNull();
    expect(deliverablesAfter(messages, 2, false)?.map((i) => i.path)).toEqual([
      "/w/report.md",
    ]);
  });

  it("holds the card while the turn is still running", () => {
    expect(deliverablesAfter(messages, 2, true)).toBeNull();
    expect(deliverablesAfter([...messages, user("u2")], 2, true)?.length).toBe(
      1
    );
  });

  it("opens a relative file resolved against the workspace", () => {
    const onOpenFile = vi.fn();
    render(
      sessionDeliverablesCard([{ path: "report.md", isUrl: false }], {
        workspaceRoot: "/w",
        onOpenFile,
        onOpenUrl: vi.fn(),
        onOpenExternal: vi.fn(),
      })
    );
    fireEvent.click(screen.getByText("report.md"));
    expect(onOpenFile).toHaveBeenCalledWith("/w/report.md");
  });
});

describe("rowEndIndex", () => {
  it("reaches the carrier folded into a coalesced host row", () => {
    const messages = [
      user("u"),
      writer("a1", "/w/a.ts"),
      writer("a2", "/w/r.md"),
    ];
    const host = {
      ...messages[1]!,
      metadata: { abacus: { coalescedIds: ["a2"] } },
    } as UIMessage;
    const at = rowEndIndex(host, { messages, index: 1 });
    expect(at).toBe(2);
    expect(deliverablesAfter(messages, at, false)?.length).toBe(1);
    expect(rowEndIndex(messages[1]!, { messages, index: 1 })).toBe(1);
  });
});
