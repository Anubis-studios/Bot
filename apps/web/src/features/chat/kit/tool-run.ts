/**
 * Consecutive tool calls of any kind collapse into one row headed by what they
 * did ("Read 3 files, ran 2 commands and searched the web"): action and count,
 * never raw arguments.
 */
export type Action =
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
