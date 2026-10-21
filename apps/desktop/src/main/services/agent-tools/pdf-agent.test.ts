/**
 * What survives into a printed document.
 *
 * The allow-list is the document's security boundary. It is applied at the
 * boundary precisely so the sub-agent's output cannot be trusted to be clean.
 * It was also, until now, the reason a document asked for "with images" printed
 * without any: `img` was not on the list, so every picture was dropped
 * silently. No warning to the user, nothing for the agent to react to.
 */
import { describe, expect, it, vi } from "vitest";

import { runPdfScript, sanitizeHtml } from "./pdf-agent";

const python = vi.hoisted(() => ({ ensurePython: vi.fn() }));
vi.mock("./python-env", () => python);
// The repository's own resources directory, as in development.
vi.mock("electron", () => ({ app: { isPackaged: false } }));

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

describe("the Python the reading and editing actions run on", () => {
  it("asks for each action's libraries and passes a setup failure to the model as is", async () => {
    const reason =
      "Could not set up Python: the download did not get through. Check the internet connection (or the proxy) and try again.";
    python.ensurePython.mockRejectedValue(new Error(reason));

    expect(await runPdfScript(["read", "/tmp/a.pdf"])).toEqual({
      ok: false,
      error: reason,
    });
    await runPdfScript(["tables", "/tmp/a.pdf"]);
    await runPdfScript(["stamp", "/tmp/a.pdf", "/tmp/b.pdf"]);
    expect(python.ensurePython.mock.calls).toEqual([
      [["pypdf"]],
      [["pypdf", "pdfplumber"]],
      [["pypdf", "reportlab"]],
    ]);
  });
});
