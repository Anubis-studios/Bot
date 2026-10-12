import { describe, expect, it } from "vitest";

import { parseAnsi, stripAnsi, tailLines } from "./ansi";

describe("parseAnsi", () => {
  it("styles colour runs as data and never builds HTML", () => {
    const runs = parseAnsi("a \u001b[31m<b>red\u001b[0m z");
    expect(runs.map((run) => run.text)).toEqual(["a ", "<b>red", " z"]);
    expect(runs[1]!.style?.color).toBeTruthy();
    expect(runs[2]!.style).toBeUndefined();
  });

  it("handles bold, 256 and truecolour, and drops other escapes", () => {
    const runs = parseAnsi("\u001b[1;38;5;196mx\u001b[2K\u001b[38;2;1;2;3my");
    expect(runs[0]!.style).toMatchObject({ fontWeight: 700 });
    expect(runs[1]!.style?.color).toBe("rgb(1,2,3)");
    expect(stripAnsi("\u001b]0;title\u0007hi\u001b[1A")).toBe("hi");
  });

  it("keeps the last redraw of a carriage-return line", () => {
    expect(stripAnsi("10%\r50%\r100%\nok")).toBe("100%\nok");
  });
});

describe("tailLines", () => {
  it("keeps the last lines and counts the hidden ones", () => {
    const text = Array.from({ length: 305 }, (_, i) => `l${i}`).join("\n");
    const tail = tailLines(text);
    expect(tail.hidden).toBe(5);
    expect(tail.text.startsWith("l5\n")).toBe(true);
    expect(tailLines("a\nb\n")).toEqual({ text: "a\nb", hidden: 0 });
  });
});
