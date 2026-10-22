/**
 * The pdf tool's reading and editing actions, in process: pdf.js (through
 * unpdf) reads text and positions, pdf-lib edits. Nothing here needs Python.
 *
 * Every action answers with one JSON-shaped object, on success and on
 * failure, so the caller never parses prose.
 */
import fs from "fs/promises";
import path from "path";

import {
  degrees,
  PDFBool,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  rgb,
  StandardFonts,
  type PDFField,
} from "pdf-lib";
import { getDocumentProxy } from "unpdf";

export type PdfScriptResult = Record<string, unknown> & { ok: boolean };

/** A failure the caller reports as is. */
class PdfError extends Error {
  constructor(
    message: string,
    readonly code = "error"
  ) {
    super(message);
  }
}

/** `1-3,7` → [0,1,2,6], clamped to the document and 1-based on the way in. */
export const parsePages = (
  spec: string | undefined,
  total: number
): number[] => {
  if (spec == null || spec.trim() === "")
    return Array.from({ length: total }, (_, index) => index);
  const pages: number[] = [];
  for (const raw of spec.split(",")) {
    const part = raw.trim();
    if (part === "") continue;
    const [start, end] = part.includes("-") ? part.split("-", 2) : [part, part];
    const lo = Number(start);
    const hi = Number(end);
    if (!Number.isInteger(lo) || !Number.isInteger(hi))
      throw new PdfError(
        part.includes("-")
          ? `bad page range: ${part}`
          : `bad page number: ${part}`
      );
    for (let page = lo; page <= hi; page += 1) pages.push(page - 1);
  }
  return pages.filter((page) => page >= 0 && page < total);
};

const readBytes = async (file: string): Promise<Uint8Array> => {
  try {
    return new Uint8Array(await fs.readFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new PdfError(`file not found: ${file}`, "not-found");
    throw error;
  }
};

/** pdf.js for reading: it copes with far more real-world files than an editor. */
const openForReading = async (file: string) =>
  await getDocumentProxy(await readBytes(file));

const openForEditing = async (file: string): Promise<PDFDocument> => {
  const document = await PDFDocument.load(await readBytes(file), {
    ignoreEncryption: true,
  });
  if (document.isEncrypted)
    throw new PdfError(
      "The PDF is encrypted, so it cannot be changed. Ask for an unlocked copy."
    );
  return document;
};

const save = async (document: PDFDocument, out: string): Promise<void> => {
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, await document.save());
};

type Line = { y: number; height: number; items: TextItem[] };
type TextItem = {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

const pageItems = async (
  pdf: Awaited<ReturnType<typeof openForReading>>,
  index: number
): Promise<TextItem[]> => {
  const content = await (await pdf.getPage(index + 1)).getTextContent();
  return content.items
    .filter((item) => "str" in item && item.str.trim() !== "")
    .map((item) => {
      const text = item as {
        str: string;
        transform: number[];
        width: number;
        height: number;
      };
      return {
        str: text.str,
        x: text.transform[4] ?? 0,
        y: text.transform[5] ?? 0,
        width: text.width,
        height: Math.abs(text.height || text.transform[3] || 10),
      };
    });
};

/** A page's text, line by line in reading order. */
const pageText = async (
  pdf: Awaited<ReturnType<typeof openForReading>>,
  index: number
): Promise<string> =>
  linesOf(await pageItems(pdf, index))
    .map(lineText)
    .join("\n");

/** A line's items joined, with a space only where the page leaves a gap. */
const lineText = (line: Line): string => {
  let text = "";
  let end = Number.NEGATIVE_INFINITY;
  for (const item of line.items) {
    const gap = item.x - end > line.height * 0.15;
    if (text !== "" && gap && !/\s$/.test(text) && !/^\s/.test(item.str))
      text += " ";
    text += item.str;
    end = Math.max(end, item.x + item.width);
  }
  return text.trimEnd();
};

/** Items on the same baseline, top to bottom, each sorted left to right. */
const linesOf = (items: TextItem[]): Line[] => {
  const lines: Line[] = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.at(-1);
    if (
      line != null &&
      Math.abs(line.y - item.y) <= Math.max(2, line.height * 0.5)
    )
      line.items.push(item);
    else lines.push({ y: item.y, height: item.height, items: [item] });
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
};

type Cell = { x: number; text: string };

/** A line split into cells wherever the gap is wider than a word space. */
const cellsOf = (line: Line): Cell[] => {
  const cells: Cell[] = [];
  let end = Number.NEGATIVE_INFINITY;
  for (const item of line.items) {
    const last = cells.at(-1);
    if (last != null && item.x - end < Math.max(4, line.height * 0.8))
      last.text += (item.x - end > line.height * 0.15 ? " " : "") + item.str;
    else cells.push({ x: item.x, text: item.str });
    end = Math.max(end, item.x + item.width);
  }
  return cells.map((cell) => ({ ...cell, text: cell.text.trim() }));
};

/**
 * Tables from text positions: runs of consecutive multi-cell lines whose
 * cells line up in columns. Ruled or image tables and cells that wrap over
 * lines are where this falls short, which the result says.
 */
const tablesOn = (lines: Line[]): Array<Array<Array<string | null>>> => {
  const tables: Array<Array<Array<string | null>>> = [];
  let run: Array<{ line: Line; cells: Cell[] }> = [];

  const flush = (): void => {
    if (run.length >= 2) {
      const tolerance = Math.max(...run.map((row) => row.line.height));
      const anchors: number[] = [];
      for (const x of run
        .flatMap((row) => row.cells.map((cell) => cell.x))
        .sort((a, b) => a - b))
        if (anchors.length === 0 || x - (anchors.at(-1) ?? x) > tolerance)
          anchors.push(x);
      if (anchors.length >= 2) {
        const rows = run.map(({ cells }) => {
          const row: Array<string | null> = anchors.map(() => null);
          for (const cell of cells) {
            let column = 0;
            for (let i = 0; i < anchors.length; i += 1)
              if ((anchors[i] ?? 0) <= cell.x + tolerance) column = i;
            row[column] =
              row[column] == null ? cell.text : `${row[column]} ${cell.text}`;
          }
          return row;
        });
        // Rows that fill most columns: prose that happens to break is not a table.
        const filled = rows.filter(
          (row) =>
            row.filter((cell) => cell != null).length >=
            Math.min(2, anchors.length)
        );
        if (filled.length >= 2) tables.push(rows);
      }
    }
    run = [];
  };

  let previous: Line | undefined;
  for (const line of lines) {
    const cells = cellsOf(line);
    const gap = previous == null ? 0 : previous.y - line.y;
    if (cells.length < 2 || (previous != null && gap > line.height * 3))
      flush();
    if (cells.length >= 2) run.push({ line, cells });
    previous = line;
  }
  flush();
  return tables;
};

/** Field type the way PDF names it, which is what the model was told before. */
const fieldType = (field: PDFField): string =>
  field instanceof PDFTextField
    ? "Tx"
    : field instanceof PDFCheckBox || field instanceof PDFRadioGroup
      ? "Btn"
      : field instanceof PDFDropdown || field instanceof PDFOptionList
        ? "Ch"
        : field instanceof PDFSignature
          ? "Sig"
          : "Btn";

const fieldValue = (field: PDFField): string => {
  if (field instanceof PDFTextField) return field.getText() ?? "";
  if (field instanceof PDFCheckBox) return field.isChecked() ? "/Yes" : "/Off";
  if (field instanceof PDFRadioGroup) return field.getSelected() ?? "";
  if (field instanceof PDFDropdown || field instanceof PDFOptionList)
    return field.getSelected().join(", ");
  return "";
};

const setField = (field: PDFField, value: unknown): boolean => {
  const text = String(value);
  if (field instanceof PDFTextField) field.setText(text);
  else if (field instanceof PDFCheckBox) {
    if (/^(\/?off|false|no|0|)$/i.test(text)) field.uncheck();
    else field.check();
  } else if (field instanceof PDFRadioGroup)
    field.select(text.replace(/^\//, ""));
  else if (field instanceof PDFDropdown || field instanceof PDFOptionList)
    field.select(text);
  else return false;
  return true;
};

type Flags = Record<string, string>;

/** Positionals and `--name value` pairs, as the tool assembles them. */
const parseArgs = (args: string[]): { positional: string[]; flags: Flags } => {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = args[i + 1] ?? "";
      i += 1;
    } else positional.push(arg);
  }
  return { positional, flags };
};

const ACTIONS: Record<
  string,
  (positional: string[], flags: Flags) => Promise<PdfScriptResult>
> = {
  info: async ([file = ""]) => {
    const pdf = await openForReading(file);
    const { info } = (await pdf.getMetadata()) as unknown as {
      info?: Record<string, unknown>;
    };
    const metadata = Object.fromEntries(
      Object.entries(info ?? {}).filter(
        ([key, value]) =>
          typeof value === "string" && key !== "PDFFormatVersion"
      )
    );
    const first = pdf.numPages > 0 ? (await pageText(pdf, 0)).trim() : "";
    const encrypted = await PDFDocument.load(await readBytes(file), {
      ignoreEncryption: true,
    }).then(
      (document) => document.isEncrypted,
      () => false
    );
    return {
      ok: true,
      pages: pdf.numPages,
      encrypted,
      metadata,
      // A scanned PDF parses fine and yields no text: the caller needs to
      // know that before it reports an empty document as an empty one.
      text_extractable: first !== "",
      hint:
        first !== ""
          ? null
          : "No text on page 1. It is likely scanned and needs OCR.",
    };
  },

  read: async ([file = ""], flags) => {
    const pdf = await openForReading(file);
    const pages = [];
    for (const index of parsePages(flags.pages, pdf.numPages))
      pages.push({ page: index + 1, text: await pageText(pdf, index) });
    return {
      ok: true,
      pages,
      characters: pages.reduce((total, page) => total + page.text.length, 0),
    };
  },

  tables: async ([file = ""], flags) => {
    const pdf = await openForReading(file);
    const tables = [];
    for (const index of parsePages(flags.pages, pdf.numPages))
      for (const rows of tablesOn(linesOf(await pageItems(pdf, index))))
        tables.push({ page: index + 1, rows });
    return {
      ok: true,
      tables,
      count: tables.length,
      note:
        tables.length > 0
          ? "Rebuilt from where the text sits on the page: check cells that wrap over lines or span columns against `read`."
          : "No table could be rebuilt from where the text sits. A table drawn as an image, or one with wrapped or merged cells, is not detected: use `read` for the text.",
    };
  },

  merge: async ([out = "", ...inputs]) => {
    const merged = await PDFDocument.create();
    for (const input of inputs) {
      const source = await openForEditing(input);
      for (const page of await merged.copyPages(
        source,
        source.getPageIndices()
      ))
        merged.addPage(page);
    }
    await save(merged, out);
    return { ok: true, output: out, pages: merged.getPageCount() };
  },

  split: async ([file = "", outDir = ""], flags) => {
    const source = await openForEditing(file);
    const total = source.getPageCount();
    const base = path.basename(file, path.extname(file));
    const ranges =
      flags.ranges != null && flags.ranges !== ""
        ? flags.ranges.split(",")
        : Array.from({ length: total }, (_, index) => String(index + 1));
    const files = [];
    for (const spec of ranges) {
      const indices = parsePages(spec, total);
      if (indices.length === 0) continue;
      const part = await PDFDocument.create();
      for (const page of await part.copyPages(source, indices))
        part.addPage(page);
      const out = path.join(
        outDir,
        `${base}-${spec.trim().replaceAll("-", "to")}.pdf`
      );
      await save(part, out);
      files.push({ path: out, pages: indices.length });
    }
    return { ok: true, files };
  },

  rotate: async ([file = "", out = ""], flags) => {
    const by = Number(flags.degrees ?? 90);
    if (!Number.isInteger(by) || by % 90 !== 0)
      throw new PdfError("degrees must be a multiple of 90");
    const document = await openForEditing(file);
    const wanted = new Set(parsePages(flags.pages, document.getPageCount()));
    document.getPages().forEach((page, index) => {
      if (wanted.has(index))
        page.setRotation(
          degrees((((page.getRotation().angle + by) % 360) + 360) % 360)
        );
    });
    await save(document, out);
    return { ok: true, output: out, rotated: wanted.size };
  },

  stamp: async ([file = "", out = ""], flags) => {
    const text = flags.text ?? "";
    if (text === "") throw new PdfError("stamp needs text");
    const opacity = Number(flags.opacity ?? 0.12);
    const document = await openForEditing(file);
    const font = await document.embedFont(StandardFonts.HelveticaBold);
    const angle = (38 * Math.PI) / 180;
    for (const page of document.getPages()) {
      const { width, height } = page.getSize();
      const size = Math.min(width, height) / 6;
      const half = font.widthOfTextAtSize(text, size) / 2;
      // Centred on the page along the slant, as a watermark is.
      page.drawText(text, {
        x: width / 2 - half * Math.cos(angle),
        y: height / 2 - half * Math.sin(angle),
        size,
        font,
        color: rgb(0, 0, 0),
        opacity,
        rotate: degrees(38),
      });
    }
    await save(document, out);
    return { ok: true, output: out, pages: document.getPageCount() };
  },

  forms: async ([file = ""]) => {
    const document = await openForEditing(file);
    const fields = document
      .getForm()
      .getFields()
      .map((field) => ({
        name: field.getName(),
        type: fieldType(field),
        value: fieldValue(field),
      }));
    return { ok: true, fields, count: fields.length };
  },

  fill: async ([file = "", out = ""], flags) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(flags.data ?? "") as Record<string, unknown>;
    } catch (error) {
      throw new PdfError(
        `--data is not valid JSON: ${(error as Error).message}`
      );
    }
    const document = await openForEditing(file);
    const form = document.getForm();
    const filled: string[] = [];
    const missing: string[] = [];
    for (const [name, value] of Object.entries(data)) {
      const field = form.getFieldMaybe(name);
      if (field != null && setField(field, value)) filled.push(name);
      else missing.push(name);
    }
    await fs.mkdir(path.dirname(out), { recursive: true });
    let bytes: Uint8Array;
    try {
      bytes = await document.save();
    } catch (error) {
      // Text the standard font cannot draw: the viewer draws it instead.
      if (!/cannot encode/i.test((error as Error).message)) throw error;
      form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
      bytes = await document.save({ updateFieldAppearances: false });
    }
    await fs.writeFile(out, bytes);
    return {
      ok: true,
      output: out,
      filled,
      ...(missing.length > 0 ? { missing } : {}),
    };
  },
};

/** Runs one action: `[action, ...positionals, --flag, value]`. */
export const runPdfOperation = async (
  args: string[]
): Promise<PdfScriptResult> => {
  const [action = "", ...rest] = args;
  const run = ACTIONS[action];
  if (run == null)
    return { ok: false, error: `unknown action: ${action}`, code: "error" };
  const { positional, flags } = parseArgs(rest);
  try {
    return await run(positional, flags);
  } catch (error) {
    if (error instanceof PdfError)
      return { ok: false, error: error.message, code: error.code };
    const failure = error as Error;
    return {
      ok: false,
      error: `${failure.name}: ${failure.message}`.slice(0, 400),
      code: "error",
    };
  }
};
