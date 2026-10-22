/**
 * What each platform actually draws. The cases here are the ones a reply hits
 * every day: a bolded list, a link, a heading, and code that must survive.
 */
import { describe, expect, it } from "vitest";

import { forChat, phoneSafeReply } from "./chat-markdown";

describe("forChat", () => {
  it("gives WhatsApp its own single-asterisk bold and bullet glyph", () => {
    const out = forChat("- **GPT-6 Astra**: their newest model", "whatsapp");
    expect(out).toBe("• *GPT-6 Astra*: their newest model");
  });

  it("leaves Telegram plain words, markers and all", () => {
    const out = forChat("- **GPT-6 Astra**: _newest_", "telegram");
    expect(out).toBe("• GPT-6 Astra: newest");
  });

  it("keeps Discord's own markdown", () => {
    expect(forChat("- **bold** and _italic_", "discord")).toBe(
      "- **bold** and *italic*"
    );
  });

  it("turns a heading into bold, or into nothing where bold has no marker", () => {
    expect(forChat("## Options", "whatsapp")).toBe("*Options*");
    expect(forChat("## Options", "telegram")).toBe("Options");
  });

  it("unwraps a link to label and url", () => {
    expect(forChat("see [the docs](https://x.dev/a)", "whatsapp")).toBe(
      "see the docs (https://x.dev/a)"
    );
  });

  it("leaves a bare url alone", () => {
    expect(forChat("https://x.dev/a", "whatsapp")).toBe("https://x.dev/a");
  });

  it("never rewrites inside code, and strips backticks where they are noise", () => {
    expect(forChat("run `npm_run_build **now**`", "whatsapp")).toBe(
      "run `npm_run_build **now**`"
    );
    expect(forChat("run `npm_run_build`", "telegram")).toBe(
      "run npm_run_build"
    );
  });

  it("keeps snake_case out of italics", () => {
    expect(forChat("the my_var_name field", "whatsapp")).toBe(
      "the my_var_name field"
    );
  });

  it("drops a horizontal rule", () => {
    expect(forChat("one\n\n---\n\ntwo", "whatsapp")).toBe("one\n\ntwo");
  });

  it("leaves a platform with no markup of its own untouched", () => {
    expect(forChat("**bold**", "abacus_channels" as never)).toBe("**bold**");
  });
});

describe("phoneSafeReply", () => {
  const safe = (text: string) => phoneSafeReply(text, "/home/me");

  it("turns a loopback preview into 💻, port, path and all", () => {
    expect(
      safe("Your store is live at http://127.0.0.1:5173/index.html.").text
    ).toBe("Your store is live at 💻.");
    expect(
      safe("Open http://localhost:3000 or [::1]:8080 to preview").text
    ).toBe("Open 💻 or 💻 to preview");
  });

  it("names a local file by its name, and reports where it is", () => {
    expect(
      safe(
        "Saved to C:\\Users\\Jo Ann\\Desktop\\app.py. And `~/Docs/report.docx`"
      )
    ).toEqual({
      text: "Saved to app.py. And `report.docx`",
      paths: [
        "C:\\Users\\Jo Ann\\Desktop\\app.py",
        "/home/me/Docs/report.docx",
      ],
    });
    expect(
      safe("See file:///Users/ann/notes.md and /tmp/out.pdf, done")
    ).toEqual({
      text: "See notes.md and out.pdf, done",
      paths: ["/Users/ann/notes.md", "/tmp/out.pdf"],
    });
    expect(safe("see C:\\temp\\a.txt and C:\\temp\\b.txt").paths).toEqual([
      "C:\\temp\\a.txt",
      "C:\\temp\\b.txt",
    ]);
  });

  it("leaves code blocks, web links and plain words alone", () => {
    const code =
      "```python\napp.run(host='127.0.0.1')\n# C:\\Users\\x\\a.py\n```";
    expect(safe(code)).toEqual({ text: code, paths: [] });
    for (const text of [
      "Docs at https://example.com/home/guide",
      "Meet at 10:30, see you",
      "and/or the user's home/office",
    ])
      expect(safe(text)).toEqual({ text, paths: [] });
  });
});
