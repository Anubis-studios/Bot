import { describe, expect, it } from "vitest";

import { linkifyKnownFiles } from "./known-files";

const files = new Map([
  ["report.pdf", "/w/out/report.pdf"],
  ["my notes (v2).md", "/w/my notes (v2).md"],
]);

describe("linkifyKnownFiles", () => {
  it("links a bare known filename in prose", () => {
    expect(linkifyKnownFiles("Saved report.pdf for you.", files)).toBe(
      "Saved [report.pdf](file:///w/out/report.pdf) for you."
    );
  });

  it("leaves code, links, paths and unknown names alone", () => {
    for (const text of [
      "`report.pdf`",
      "```\nreport.pdf\n```",
      "[report.pdf](https://x.test)",
      "see out/report.pdf",
      "other.pdf",
      "xreport.pdf",
    ])
      expect(linkifyKnownFiles(text, files)).toBe(text);
  });

  it("escapes parentheses and spaces in the target", () => {
    expect(linkifyKnownFiles("open my notes (v2).md now", files)).toBe(
      "open [my notes (v2).md](file:///w/my%20notes%20%28v2%29.md) now"
    );
  });
});
