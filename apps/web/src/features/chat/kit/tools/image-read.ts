/**
 * An image `read` returns a JSON envelope rather than text:
 * `{ type: "read", status: "success", mimeType: "image/png", filePath, ... }`.
 * Detect it so the row can show a thumbnail instead of a JSON block.
 */
export interface ImageRead {
  filePath: string;
  filename: string;
  size: number;
  mimeType: string;
}

export const parseImageRead = (text: string): ImageRead | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "read" || obj.status !== "success") return null;
  const mimeType = typeof obj.mimeType === "string" ? obj.mimeType : "";
  if (!mimeType.startsWith("image/")) return null;
  const filePath = typeof obj.filePath === "string" ? obj.filePath : "";
  if (filePath === "") return null;
  return {
    filePath,
    filename: typeof obj.filename === "string" ? obj.filename : "",
    size: typeof obj.size === "number" ? obj.size : 0,
    mimeType,
  };
};

export const formatBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
