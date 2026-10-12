/**
 * The builtin component tools (pdf, ppt, design, document, deck_export_pdf,
 * app preview, present_deliverable) as a tool row shows them: a label such as
 * "Built deck", the file chip, and the file a click opens in the preview.
 * Pure; the path logic is shared with the deliverables card
 * (`lib/bot-turns/component-tools`) so the two never disagree.
 */
import {
  basename,
  componentOutputPath,
  componentToolBase,
  type ComponentToolBase,
} from "#renderer/lib/bot-turns/component-tools";

export type Translate = (
  key: string,
  options?: Record<string, unknown>
) => string;

export interface ComponentLine {
  /** "Built deck", "Designed", "Opened". */
  action: string;
  /** The file (or URL) the call produced, shown after the action. */
  chip?: string;
  /** The file a click opens in the preview; absent for URLs and no-ops. */
  targetPath?: string;
}

const MCP_PREFIX = "agent-tools_";

/** The app preview tool is `preview` / `open_preview` with a `path` argument. */
const isPreviewTool = (name: string): boolean => {
  const bare = name.startsWith(MCP_PREFIX)
    ? name.slice(MCP_PREFIX.length)
    : name;
  return bare === "open_preview" || bare === "preview" || bare === "app";
};

/** `serve` (a directory over http): its URL arrives in the result text. */
const isServeTool = (name: string): boolean => {
  const bare = name.startsWith(MCP_PREFIX)
    ? name.slice(MCP_PREFIX.length)
    : name;
  return bare === "serve";
};

const SERVED_URL_RE = /\bhttps?:\/\/[^\s"'<>)]+/i;

const truncate = (value: string, max = 50): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/** True for a component tool that opens a file or URL, for gating the row. */
export const isComponentTool = (name: string): boolean =>
  componentToolBase(name) != null || isPreviewTool(name) || isServeTool(name);

const lineFor = (
  base: ComponentToolBase,
  input: Record<string, unknown>,
  running: boolean,
  t: Translate
): ComponentLine | null => {
  const str = (key: string): string => String(input[key] ?? "").trim();
  const pick = (active: string, done: string): string =>
    t(running ? active : done);
  const target = componentOutputPath(base, input);

  if (base === "document") {
    const action = pick(
      "chat.tool.componentDocumentActive",
      "chat.tool.componentDocumentDone"
    );
    return target == null
      ? { action }
      : { action, chip: basename(target), targetPath: target };
  }
  if (base === "pdf" || base === "ppt" || base === "deck_export_pdf") {
    const reprint = base === "pdf" && str("action") === "reprint";
    const deck = base === "ppt";
    if (target == null)
      return {
        action: pick(
          "chat.tool.componentIdleActive",
          "chat.tool.componentIdleDone"
        ),
        chip: t(
          deck ? "chat.tool.componentChipDeck" : "chat.tool.componentChipPdf"
        ),
      };
    const action = reprint
      ? pick("chat.tool.componentPrintActive", "chat.tool.componentPrintDone")
      : deck
        ? pick("chat.tool.componentDeckActive", "chat.tool.componentDeckDone")
        : pick("chat.tool.componentPdfActive", "chat.tool.componentPdfDone");
    return { action, chip: basename(target), targetPath: target };
  }
  if (base === "design") {
    const action = pick(
      "chat.tool.componentDesignActive",
      "chat.tool.componentDesignDone"
    );
    return target == null
      ? { action }
      : {
          action,
          chip: basename(str("output_dir").replace(/[\\/]+$/, "")),
          targetPath: target,
        };
  }
  // present_deliverable: the files render as the turn's card; the row stays generic.
  return null;
};

/**
 * The row's label for a component tool call, or null when `name` is not one
 * (or is `present_deliverable`, whose row stays generic).
 */
export const componentLine = (
  name: string,
  input: Record<string, unknown>,
  running: boolean,
  t: Translate,
  resultText = ""
): ComponentLine | null => {
  const base = componentToolBase(name);
  if (base != null) return lineFor(base, input, running, t);
  if (isServeTool(name)) {
    // Only `start` hands back something to open; stop and list stay generic.
    if (String(input.action ?? "").trim() !== "start") return null;
    const url = SERVED_URL_RE.exec(resultText)?.[0];
    return {
      action: t(
        running
          ? "chat.tool.componentServeActive"
          : "chat.tool.componentServeDone"
      ),
      ...(url != null ? { chip: truncate(url), targetPath: url } : {}),
    };
  }
  if (!isPreviewTool(name)) return null;
  const target = String(input.path ?? "").trim();
  if (target.length === 0)
    return {
      action: t(
        running
          ? "chat.tool.componentPreviewActive"
          : "chat.tool.componentPreviewDone"
      ),
    };
  const isUrl = /^https?:\/\//i.test(target);
  return {
    action: t(
      running ? "chat.tool.componentOpenActive" : "chat.tool.componentOpenDone"
    ),
    chip: isUrl ? truncate(target) : basename(target),
    targetPath: target,
  };
};
