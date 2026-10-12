import { describe, expect, it } from "vitest";

import { actionOf, toolRunCounts, toolRunKind } from "./tool-run";

describe("actionOf", () => {
  it("classes the names the agent emits, from its own kind table", () => {
    expect(actionOf("batch_file_read")).toBe("Read");
    expect(actionOf("ast_edit")).toBe("Edit");
    expect(actionOf("apply_patch")).toBe("Edit");
    expect(actionOf("find")).toBe("CodeSearch");
    expect(actionOf("code_map")).toBe("CodeSearch");
    expect(actionOf("web_search")).toBe("WebSearch");
    expect(actionOf("web_fetch")).toBe("WebSearch");
    for (const name of [
      "bash",
      "read_output",
      "fetch_background_output",
      "kill_process",
    ])
      expect(actionOf(name)).toBe("Command");
  });

  it("names browser, MCP, plan, ask, sub-agent, deliverable and component tools", () => {
    expect(actionOf("browser_task")).toBe("Browser");
    expect(actionOf("mcp__linear__create_issue")).toBe("Mcp");
    expect(actionOf("todo")).toBe("Plan");
    expect(actionOf("exit_plan_mode")).toBe("Plan");
    expect(actionOf("ask_user_question")).toBe("Ask");
    expect(actionOf("delegate_task")).toBe("Subagent");
    expect(actionOf("present_deliverable")).toBe("Present");
    expect(actionOf("agent-tools_present_deliverable")).toBe("Present");
    expect(actionOf("agent-tools_ppt")).toBe("Create");
    expect(actionOf("something_new")).toBe("Other");
  });
});

describe("toolRunCounts", () => {
  it("counts a command and its background output as one action", () => {
    const calls = [{ name: "bash" }, { name: "read_output" }];
    expect(toolRunCounts(calls)).toEqual([["Command", 2]]);
    expect(toolRunKind(calls)).toBe("Command");
  });

  it("counts distinct edited files, including ast_edit", () => {
    expect(
      toolRunCounts([
        { name: "edit", input: { path: "a.ts" } },
        { name: "ast_edit", input: { path: "a.ts" } },
        { name: "write", input: { file_path: "b.ts" } },
      ])
    ).toEqual([["Edit", 2]]);
  });
});
