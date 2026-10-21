/**
 * pi's `read`, with documents read as their text: a PDF or Word file the user
 * points at must not come back as raw bytes, nor wait on a shell or Python.
 * Registered under pi's name, so it replaces the built-in.
 */
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";

import {
  createReadToolDefinition,
  detectSupportedImageMimeTypeFromFile,
} from "@earendil-works/pi-coding-agent";

import { readableText } from "./document-text.js";

export function buildReadTool(
  cwd: string
): ReturnType<typeof createReadToolDefinition> {
  const definition = createReadToolDefinition(cwd, {
    operations: {
      access: (file) => access(file, constants.R_OK),
      detectImageMimeType: detectSupportedImageMimeTypeFromFile,
      readFile: async (file) => {
        const data = await readFile(file);
        // Images go to the model as attachments, byte for byte.
        if ((await detectSupportedImageMimeTypeFromFile(file)) != null)
          return data;
        const text = await readableText(file, data);
        return text == null ? data : Buffer.from(text, "utf8");
      },
    },
  });
  return {
    ...definition,
    description: `${definition.description} PDFs and Word documents (.docx) come back as their text, page by page for a PDF.`,
  };
}
