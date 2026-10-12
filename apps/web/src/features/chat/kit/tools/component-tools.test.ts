import { describe, expect, it } from "vitest";

import { componentLine, isComponentTool } from "./component-tools";

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

describe("componentLine", () => {
  it("labels a deck build and normalises its output to .pdf", () => {
    expect(
      componentLine(
        "agent-tools_ppt",
        { output_path: "out/deck.pptx" },
        false,
        t
      )
    ).toEqual({
      action: "chat.tool.componentDeckDone",
      chip: "deck.pdf",
      targetPath: "out/deck.pdf",
    });
  });

  it("uses the running label while the call is running", () => {
    expect(
      componentLine("pdf", { output_path: "a.pdf" }, true, t)?.action
    ).toBe("chat.tool.componentPdfActive");
  });

  it("points a design at its canvas.html", () => {
    expect(
      componentLine("agent-tools_design", { output_dir: "/w/ui/" }, false, t)
    ).toEqual({
      action: "chat.tool.componentDesignDone",
      chip: "ui",
      targetPath: "/w/ui/canvas.html",
    });
  });

  it("labels a reprint and derives its target", () => {
    expect(
      componentLine(
        "pdf",
        { action: "reprint", html_path: "/w/r-source/document.html" },
        false,
        t
      )
    ).toMatchObject({
      action: "chat.tool.componentPrintDone",
      targetPath: "/w/r.pdf",
    });
  });

  it("has no target for a pdf read", () => {
    expect(componentLine("pdf", { action: "read" }, false, t)).toEqual({
      action: "chat.tool.componentIdleDone",
      chip: "chat.tool.componentChipPdf",
    });
  });

  it("opens a served app URL without a file target", () => {
    expect(
      componentLine(
        "open_preview",
        { path: "http://localhost:3000/app" },
        false,
        t
      )
    ).toEqual({
      action: "chat.tool.componentOpenDone",
      chip: "http://localhost:3000/app",
    });
  });

  it("recognises component tools and leaves others alone", () => {
    expect(isComponentTool("agent-tools_document")).toBe(true);
    expect(isComponentTool("bash")).toBe(false);
    expect(componentLine("bash", {}, false, t)).toBeNull();
    expect(componentLine("present_deliverable", {}, false, t)).toBeNull();
  });
});
