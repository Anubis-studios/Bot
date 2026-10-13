import fs from "node:fs";
import path from "node:path";

import { nodeIo, writeFileAtomic } from "../../migrations/backup";
import { readRendererStateFile } from "./renderer-state";

const receiptFile = (home: string) =>
  path.join(home, "electron", "composer-drafts.imported.json");
// Missing, unreadable or malformed: nothing is acknowledged, so nothing is lost.
const receipts = (home: string): string[] => {
  try {
    const keys: unknown = JSON.parse(
      fs.readFileSync(receiptFile(home), "utf8")
    );
    return Array.isArray(keys)
      ? keys.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
};

/**
 * v1.0.85 keys are `composer.draft:session:<id>` and
 * `composer.draft:workspace:<id>` (a workspace's new-session box). A session's
 * draft is keyed by the bare session id, as the composer reads it.
 */
export const pendingLegacyDrafts = (home: string): Record<string, string> => {
  const imported = new Set(receipts(home));
  return Object.fromEntries(
    [
      ...readRendererStateFile(
        path.join(home, "electron", "renderer-state.json")
      ),
    ]
      .filter(
        ([key, text]) =>
          /^composer\.draft:(session|workspace):./.test(key) && text !== ""
      )
      .map(([key, text]) => [
        key.slice("composer.draft:".length).replace(/^session:/, ""),
        text,
      ])
      .filter(([key]) => !imported.has(key!))
  );
};

/** Called after the renderer has persisted the imported text. Keep the source for recovery. */
export const acknowledgeLegacyDrafts = (home: string, keys: string[]): void => {
  fs.mkdirSync(path.dirname(receiptFile(home)), { recursive: true });
  writeFileAtomic(
    receiptFile(home),
    JSON.stringify([...new Set([...receipts(home), ...keys])]),
    nodeIo
  );
};
