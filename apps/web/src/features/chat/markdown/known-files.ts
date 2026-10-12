/**
 * Bare deliverable filenames in prose ("report.pdf") become links to the file
 * when the session already recorded an artifact with exactly that name, so
 * every link points at a file that was written. A route feeds the names for a
 * thread (`setKnownFiles`); `Markdown` reads them for its own thread.
 */
import { Store, useSelector } from "@tanstack/react-store";

type Files = ReadonlyMap<string, string>;

const NONE: Files = new Map();
const store = new Store<Readonly<Record<string, Files>>>({});

export const setKnownFiles = (threadId: string, files: Files): void => {
  store.setState((state) => {
    if (files.size === 0 && state[threadId] == null) return state;
    const { [threadId]: _dropped, ...rest } = state;
    return files.size === 0 ? rest : { ...rest, [threadId]: files };
  });
};

export const useKnownFiles = (threadId: string | undefined): Files =>
  useSelector(store, (state) =>
    threadId == null ? NONE : (state[threadId] ?? NONE)
  );

/** Document kinds worth linking: the deliverable, not every `.ts` named. */
const LINKABLE_EXTENSIONS = new Set([
  "pdf",
  "pptx",
  "ppt",
  "md",
  "html",
  "htm",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "csv",
  "docx",
  "xlsx",
  "txt",
  "json",
]);

/**
 * Regions left exactly as written: fenced blocks, inline code, existing links
 * and images, and raw HTML.
 */
const PROTECTED_RE = /```[\s\S]*?```|`[^`]*`|!?\[[^\]]*\]\([^)]*\)|<[^>]+>/g;

const escapeForRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toFileUrl = (absPath: string): string => {
  const slashed = absPath.replace(/\\/g, "/");
  const rooted = slashed.startsWith("/") ? slashed : `/${slashed}`;
  return `file://${encodeURI(rooted)
    .replace(/#/g, "%23")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")}`;
};

export const linkifyKnownFiles = (content: string, files: Files): string => {
  if (files.size === 0 || content.length === 0) return content;
  const names = [...files.keys()]
    .filter((name) => {
      const dot = name.lastIndexOf(".");
      return (
        dot > 0 && LINKABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
      );
    })
    // Longest first so `report final.pdf` wins over a name it contains.
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return content;
  // Not part of a longer path or word on either side.
  const nameRe = new RegExp(
    `(^|[^\\w/\\\\.-])(${names.map(escapeForRegex).join("|")})(?![\\w/\\\\-])`,
    "g"
  );
  const rewrite = (chunk: string): string =>
    chunk.replace(nameRe, (match, prefix: string, name: string) => {
      const abs = files.get(name);
      return abs == null ? match : `${prefix}[${name}](${toFileUrl(abs)})`;
    });
  let out = "";
  let cursor = 0;
  PROTECTED_RE.lastIndex = 0;
  for (
    let m = PROTECTED_RE.exec(content);
    m != null;
    m = PROTECTED_RE.exec(content)
  ) {
    out += rewrite(content.slice(cursor, m.index)) + m[0];
    cursor = m.index + m[0].length;
  }
  return out + rewrite(content.slice(cursor));
};
