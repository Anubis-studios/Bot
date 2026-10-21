/**
 * Text out of the documents people attach, PDF and Word, in this process:
 * reading one must not depend on a shell or a Python install.
 */
import * as path from "node:path";

import mammoth from "mammoth";
import { getDocumentProxy } from "unpdf";

/** Larger than any brief; past it, parsing would stall the agent's turn. */
const DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;

/** One page's text, 1-based. */
interface PdfPageText {
  page: number;
  text: string;
}

const isPdf = (data: Uint8Array): boolean =>
  Buffer.from(data.subarray(0, 5)).toString("latin1") === "%PDF-";

const isZip = (data: Uint8Array): boolean =>
  data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;

/** Windows tools write UTF-16 text; its NULs are not a binary file's. */
const utf16Text = (data: Uint8Array): string | null =>
  data[0] === 0xff && data[1] === 0xfe
    ? Buffer.from(data.subarray(2)).toString("utf16le")
    : null;

/** A NUL in the first 8 KB, the same test git uses. */
const isBinary = (data: Uint8Array): boolean =>
  data.subarray(0, 8192).includes(0);

/** Every page's text. Throws on a PDF that will not open, such as a locked one. */
async function pdfPagesText(
  data: Uint8Array
): Promise<{ totalPages: number; pages: PdfPageText[] }> {
  // verbosity 0: pdf.js warns through console.log, which is this process's protocol stream.
  const pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
  try {
    const pages: PdfPageText[] = [];
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      const text = content.items
        .map((item) =>
          "str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""
        )
        .join("");
      pages.push({ page, text });
    }
    return { totalPages: pdf.numPages, pages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

const pdfAsText = async (data: Uint8Array): Promise<string> => {
  const { totalPages, pages } = await pdfPagesText(data);
  const plural = totalPages === 1 ? "page" : "pages";
  if (pages.every((page) => page.text.trim().length === 0)) {
    return `[PDF, ${totalPages} ${plural}, with no text layer: it is probably a scan, so its words are only in the page images.]`;
  }
  return [
    `[PDF, ${totalPages} ${plural}]`,
    ...pages.map((page) => `\n--- Page ${page.page} ---\n${page.text.trim()}`),
  ].join("\n");
};

const docxAsText = async (data: Uint8Array): Promise<string> => {
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
  return `[Word document]\n\n${value.trim()}`;
};

/**
 * What `read` shows for a file that is not plain text: a document's text, or
 * a short note for any other binary. Null for text, which reads as it is.
 */
export async function readableText(
  filePath: string,
  data: Uint8Array
): Promise<string | null> {
  const pdf = isPdf(data);
  const zip = isZip(data);
  if (!pdf && !zip && !isBinary(data)) return null;
  const utf16 = utf16Text(data);
  if (utf16 != null) return utf16;

  const name = path.basename(filePath);
  const kb = Math.ceil(data.byteLength / 1024);
  const docx = zip && /\.(docx|docm)$/i.test(name);
  if ((pdf || docx) && data.byteLength > DOCUMENT_MAX_BYTES) {
    return `[${name} (${kb} KB) is too large to extract its text here.]`;
  }
  try {
    if (pdf) return await pdfAsText(data);
    if (docx) return await docxAsText(data);
  } catch (error) {
    return `[${name}: its text could not be extracted (${error instanceof Error ? error.message : String(error)}).]`;
  }
  return zip && /\.zip$/i.test(name)
    ? `[${name} is a zip archive (${kb} KB). Extract it with unzip in the shell, then read the files inside.]`
    : `[${name} is a binary file (${kb} KB) with no text read can show.]`;
}
