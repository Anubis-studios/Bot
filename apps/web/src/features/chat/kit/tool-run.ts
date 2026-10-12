/**
 * Consecutive tool calls of any kind collapse into one row headed by what they
 * did ("Read 3 files, ran 2 commands and searched the web"): action and count,
 * never raw arguments.
 */
import { toToolKind, type ToolKind } from "@abacus-ai/agent/tool-display";

import { componentToolBase } from "#renderer/lib/bot-turns/component-tools";

export type Action =
  | "Read"
  | "Edit"
  | "Command"
  | "CodeSearch"
  | "WebSearch"
  | "Browser"
  | "Mcp"
  | "Plan"
  | "Ask"
  | "Subagent"
  | "Present"
  | "Create"
  | "Other";

/** Background-shell tools read like commands, whatever their wire kind. */
const COMMAND_TOOLS = new Set([
  "read_output",
  "fetch_background_output",
  "kill_process",
]);
const CODE_SEARCH_TOOLS = new Set(["code_map"]);
const PLAN_TOOLS = new Set(["todo", "todo_write", "exit_plan_mode"]);

/**
 * Names the agent's kind table may not know: current tools and the aliases
 * migrated history carries. Checked before the table.
 */
const ALIASES: Record<string, Action> = {
  batch_file_read: "Read",
  batch_edit: "Edit",
  web_search_text_only: "WebSearch",
  scrape_url_content: "WebSearch",
  grep: "CodeSearch",
  glob: "CodeSearch",
};

const kindOf = (name: string): ToolKind => {
  try {
    return toToolKind(name);
  } catch {
    return "other";
  }
};

/**
 * The header's class for one call. The agent's own `toToolKind` is the one
 * table for file/command/search tools (the tool rows use it for their icon);
 * the rest are named by what the call is for.
 */
/** Drops the `agent-tools_` prefix some wire names carry. */
const bareName = (name: string): string =>
  name.startsWith("agent-tools_") ? name.slice("agent-tools_".length) : name;

export const actionOf = (name: string): Action => {
  if (COMMAND_TOOLS.has(name)) return "Command";
  const alias = ALIASES[bareName(name)];
  if (alias != null) return alias;
  if (name === "present_deliverable" || name.endsWith("_present_deliverable"))
    return "Present";
  if (componentToolBase(name) != null) return "Create";
  if (name === "ask_user_question") return "Ask";
  if (name.startsWith("browser")) return "Browser";
  if (name.startsWith("mcp__")) return "Mcp";
  if (PLAN_TOOLS.has(name)) return "Plan";
  if (CODE_SEARCH_TOOLS.has(name)) return "CodeSearch";
  switch (kindOf(name)) {
    case "read":
      return "Read";
    case "edit":
    case "delete":
    case "move":
      return "Edit";
    case "execute":
      return "Command";
    case "search":
      return name === "web_search" ? "WebSearch" : "CodeSearch";
    case "fetch":
      return "WebSearch";
    case "think":
      return "Subagent";
    case "switch_mode":
      return "Plan";
    default:
      return "Other";
  }
};

export interface RunCall {
  name: string;
  input?: unknown;
}

const pathOf = (input: unknown): string | null => {
  if (input == null || typeof input !== "object") return null;
  for (const key of ["file_path", "path", "filepath", "notebook_path"]) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
};

/**
 * `[action, count]` in order of first use. Edits count distinct files, so
 * three edits to one file read "Changed 1 file".
 */
export const toolRunCounts = (
  calls: readonly RunCall[]
): Array<[Action, number]> => {
  const counts = new Map<Action, number>();
  const files = new Set<string>();
  for (const call of calls) {
    const action = actionOf(call.name);
    const path = action === "Edit" ? pathOf(call.input) : null;
    if (path != null) {
      if (files.has(path)) continue;
      files.add(path);
    }
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  return [...counts];
};

/** The one action every call shares, or `"mixed"`. */
export const toolRunKind = (calls: readonly RunCall[]): Action | "mixed" => {
  const kinds = new Set(calls.map((call) => actionOf(call.name)));
  return kinds.size === 1 ? [...kinds][0]! : "mixed";
};

/** Joins labels as a sentence; later labels start lowercase in English. */
export const joinLabels = (labels: string[], language: string): string => {
  const lower = language.startsWith("en");
  const parts = labels.map((label, index) =>
    lower && index > 0 ? label.charAt(0).toLowerCase() + label.slice(1) : label
  );
  try {
    return new Intl.ListFormat(language, {
      style: "long",
      type: "conjunction",
    }).format(parts);
  } catch {
    return parts.join(", ");
  }
};
