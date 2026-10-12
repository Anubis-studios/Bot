/**
 * Consecutive tool calls with no server-made group collapse into one row
 * headed by what they did ("3 files read, 2 commands run"): action and count,
 * never raw arguments.
 */
type Action =
  | "Read"
  | "Edit"
  | "Command"
  | "CodeSearch"
  | "WebSearch"
  | "Other";

const ACTIONS: Array<[Action, ReadonlySet<string>]> = [
  ["Read", new Set(["read", "ls", "image_view"])],
  [
    "Edit",
    new Set([
      "write",
      "edit",
      "batch_edit",
      "notebook_edit",
      "delete",
      "apply_patch",
    ]),
  ],
  ["Command", new Set(["bash", "bash_output", "kill_shell", "exec_command"])],
  ["CodeSearch", new Set(["glob", "grep", "codebase_search"])],
  ["WebSearch", new Set(["web_search", "web_fetch"])],
];

const actionOf = (name: string): Action =>
  ACTIONS.find(([, names]) => names.has(name))?.[0] ?? "Other";

/** `[key, count]` per action, in order of first use. */
export const toolRunCounts = (
  names: readonly string[]
): Array<[Action, number]> => {
  const counts = new Map<Action, number>();
  for (const name of names) {
    const action = actionOf(name);
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  return [...counts];
};
