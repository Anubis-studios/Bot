import { describe, expect, it } from "vitest";

import { humanToolName, stripLineNumbers, todoItems } from "./normalize";
import { resolveWorkspacePath, toolOpenPath } from "./tool-meta";

describe("tool helpers", () => {
  it("strips arrow line-number prefixes only when every line has one", () => {
    expect(stripLineNumbers("   12→a\n   13→b")).toEqual({
      text: "a\nb",
      startLine: 12,
    });
    expect(stripLineNumbers("1→a\nplain").text).toBe("1→a\nplain");
  });

  it("reads checklist items with defaulted status", () => {
    expect(
      todoItems({
        todos: [{ content: " a ", status: "completed" }, { content: "b" }, 3],
      })
    ).toEqual([
      { content: "a", status: "completed" },
      { content: "b", status: "pending" },
    ]);
  });

  it("names MCP tools without their prefix", () => {
    expect(humanToolName("mcp__linear__create_issue")).toBe("Create Issue");
    expect(humanToolName("agent-tools_web_fetch")).toBe("Web Fetch");
  });

  it("resolves relative paths against the workspace", () => {
    expect(resolveWorkspacePath("src/a.ts", "/ws/")).toBe("/ws/src/a.ts");
    expect(resolveWorkspacePath("/abs/a.ts", "/ws")).toBe("/abs/a.ts");
    expect(toolOpenPath("edit", { file_path: "./a.ts" }, "/ws")).toBe(
      "/ws/a.ts"
    );
    expect(toolOpenPath("bash", { path: "x" }, "/ws")).toBeNull();
  });
});
