/**
 * What survives into a printed document.
 *
 * The allow-list is the document's security boundary. It is applied at the
 * boundary precisely so the sub-agent's output cannot be trusted to be clean.
 * It was also, until now, the reason a document asked for "with images" printed
 * without any: `img` was not on the list, so every picture was dropped
 * silently. No warning to the user, nothing for the agent to react to.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sanitizeHtml } from "./pdf-agent";
import { runPdfOperation } from "./pdf-ops";

describe("images in a printed document", () => {
  it("keeps a local file image, which is what the agent produces", () => {
    const html =
      '<p>Before</p><img src="file:///tmp/dosa.jpg" alt="Dosa"><p>After</p>';
    expect(sanitizeHtml(html)).toContain(
      '<img src="file:///tmp/dosa.jpg" alt="Dosa">'
    );
  });

  it("keeps an inline data image", () => {
    const html = '<img src="data:image/png;base64,iVBORw0KGgo=">';
    expect(sanitizeHtml(html)).toContain("data:image/png");
  });

  it("keeps a relative path, which resolves beside the HTML being printed", () => {
    expect(sanitizeHtml('<img src="images/thali.jpg">')).toContain(
      '<img src="images/thali.jpg">'
    );
  });

  it("keeps a Windows drive-letter path, which is a local file, not a scheme", () => {
    // Lowercased, "C:\..." starts with `c:` and looks like a URL scheme to a
    // naive test, which silently stripped every locally-generated image from
    // PDFs printed on Windows.
    const html = '<img src="C:\\Users\\me\\chart.png" alt="Chart">';
    expect(sanitizeHtml(html)).toContain(
      '<img src="C:\\Users\\me\\chart.png" alt="Chart">'
    );
  });

  it("keeps a forward-slash drive-letter path too", () => {
    expect(sanitizeHtml('<img src="c:/temp/plot.png">')).toContain(
      '<img src="c:/temp/plot.png">'
    );
  });

  it("keeps figure and figcaption, since a picture is usually captioned", () => {
    const html =
      '<figure><img src="a.png"><figcaption>A thali</figcaption></figure>';
    const out = sanitizeHtml(html);
    expect(out).toContain("<figure>");
    expect(out).toContain("<figcaption>");
  });
});

describe("what an image may not do", () => {
  it("drops a remote image rather than fetching it at print time", () => {
    // The document is assembled from pages the model just read; a src it chose
    // must not become an outbound request when the PDF is printed.
    const out = sanitizeHtml(
      '<p>Text</p><img src="https://tracker.example/pixel.png">'
    );
    expect(out).not.toContain("img");
    expect(out).toContain("Text");
  });

  it("drops a protocol-relative image for the same reason", () => {
    expect(
      sanitizeHtml('<img src="//tracker.example/pixel.png">')
    ).not.toContain("img");
  });

  it("drops an image with no source at all", () => {
    expect(sanitizeHtml('<img alt="nothing">')).not.toContain("img");
  });

  it("still strips scripts, handlers and javascript: URLs", () => {
    const html =
      '<script>alert(1)</script><img src="a.png" onerror="steal()"><a href="javascript:x()">go</a>';
    const out = sanitizeHtml(html);
    expect(out).not.toContain("script");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("javascript:");
  });
});

describe("reading and editing, in process", () => {
  let dir: string;
  const at = (name: string): string => path.join(dir, name);

  /** Two pages of prose, then a page holding a three-column table. */
  const report = async (): Promise<string> => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    document.setTitle("Quarterly report");
    document.addPage([612, 792]).drawText("Revenue grew 12% this quarter.", {
      x: 72,
      y: 700,
      size: 12,
      font,
    });
    document
      .addPage([612, 792])
      .drawText("Page two", { x: 72, y: 700, size: 12, font });
    const table = document.addPage([612, 792]);
    const rows = [
      ["Region", "Q1", "Q2"],
      ["North", "120", "135"],
      ["South", "98", "101"],
    ];
    rows.forEach((row, r) =>
      row.forEach((text, c) =>
        table.drawText(text, {
          x: 72 + c * 150,
          y: 700 - r * 20,
          size: 12,
          font,
        })
      )
    );
    const file = at("report.pdf");
    fs.writeFileSync(file, await document.save());
    return file;
  };

  const form = async (): Promise<string> => {
    const document = await PDFDocument.create();
    const page = document.addPage([612, 792]);
    const fields = document.getForm();
    fields.createTextField("name").addToPage(page, { x: 72, y: 700 });
    fields.createCheckBox("agree").addToPage(page, { x: 72, y: 650 });
    const file = at("form.pdf");
    fs.writeFileSync(file, await document.save());
    return file;
  };

  let pdf: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-ops-"));
    pdf = await report();
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("info: pages, metadata, and whether there is text", async () => {
    const info = await runPdfOperation(["info", pdf]);
    expect(info).toMatchObject({
      ok: true,
      pages: 3,
      encrypted: false,
      text_extractable: true,
      hint: null,
    });
    expect(info.metadata).toMatchObject({ Title: "Quarterly report" });
  });

  it("read: text per page, for the pages asked", async () => {
    expect(await runPdfOperation(["read", pdf, "--pages", "1-2"])).toEqual({
      ok: true,
      pages: [
        { page: 1, text: "Revenue grew 12% this quarter." },
        { page: 2, text: "Page two" },
      ],
      characters: 38,
    });
    expect(await runPdfOperation(["read", pdf, "--pages", "x"])).toMatchObject({
      ok: false,
      error: "bad page number: x",
    });
  });

  it("tables: rebuilt from text positions, and says when there are none", async () => {
    const found = await runPdfOperation(["tables", pdf]);
    expect(found).toMatchObject({
      ok: true,
      count: 1,
      tables: [
        {
          page: 3,
          rows: [
            ["Region", "Q1", "Q2"],
            ["North", "120", "135"],
            ["South", "98", "101"],
          ],
        },
      ],
    });
    const none = await runPdfOperation(["tables", pdf, "--pages", "1"]);
    expect(none).toMatchObject({ ok: true, count: 0 });
    expect(String(none.note)).toContain("No table could be rebuilt");
  });

  it("merge, split and rotate move pages", async () => {
    expect(
      await runPdfOperation(["merge", at("merged.pdf"), pdf, pdf])
    ).toEqual({ ok: true, output: at("merged.pdf"), pages: 6 });

    const split = await runPdfOperation([
      "split",
      pdf,
      at("parts"),
      "--ranges",
      "1-2,3",
    ]);
    expect(split).toEqual({
      ok: true,
      files: [
        { path: path.join(at("parts"), "report-1to2.pdf"), pages: 2 },
        { path: path.join(at("parts"), "report-3.pdf"), pages: 1 },
      ],
    });

    expect(
      await runPdfOperation([
        "rotate",
        pdf,
        at("rotated.pdf"),
        "--degrees",
        "90",
        "--pages",
        "1",
      ])
    ).toEqual({ ok: true, output: at("rotated.pdf"), rotated: 1 });
    const rotated = await PDFDocument.load(fs.readFileSync(at("rotated.pdf")));
    expect(rotated.getPages().map((page) => page.getRotation().angle)).toEqual([
      90, 0, 0,
    ]);
  });

  it("stamp marks every page and keeps the text", async () => {
    expect(
      await runPdfOperation([
        "stamp",
        pdf,
        at("stamped.pdf"),
        "--text",
        "DRAFT",
      ])
    ).toEqual({ ok: true, output: at("stamped.pdf"), pages: 3 });
    const read = await runPdfOperation([
      "read",
      at("stamped.pdf"),
      "--pages",
      "1",
    ]);
    expect(JSON.stringify(read)).toContain("Revenue grew 12%");
    expect(JSON.stringify(read)).toContain("DRAFT");
  });

  it("forms lists fields and fill sets them", async () => {
    const blank = await form();
    expect(await runPdfOperation(["forms", blank])).toEqual({
      ok: true,
      count: 2,
      fields: [
        { name: "name", type: "Tx", value: "" },
        { name: "agree", type: "Btn", value: "/Off" },
      ],
    });
    expect(
      await runPdfOperation([
        "fill",
        blank,
        at("filled.pdf"),
        "--data",
        JSON.stringify({ name: "Alex", agree: true, nope: "x" }),
      ])
    ).toEqual({
      ok: true,
      output: at("filled.pdf"),
      filled: ["name", "agree"],
      missing: ["nope"],
    });
    expect(await runPdfOperation(["forms", at("filled.pdf")])).toMatchObject({
      fields: [
        { name: "name", value: "Alex" },
        { name: "agree", value: "/Yes" },
      ],
    });
  });

  it("answers a missing file as data", async () => {
    expect(await runPdfOperation(["info", at("nope.pdf")])).toEqual({
      ok: false,
      error: `file not found: ${at("nope.pdf")}`,
      code: "not-found",
    });
  });
});
