/**
 * Step 7: the on-device model runtime is gone. Every stored pick of a
 * `local/<id>` model falls back to the app default (null, or no
 * `defaultModel`), and the `local` provider the app registered in
 * `config.json` is dropped. Users' own custom providers are left alone.
 */
import fs from "node:fs";
import path from "node:path";

import type { MigrationContext, MigrationStep, PlannedWrite } from "../types";

/** The provider id the retired runtime registered its models under. */
const RETIRED_PROVIDER_ID = "local";

const isRetiredModel = (model: unknown): boolean =>
  typeof model === "string" && model.startsWith(`${RETIRED_PROVIDER_ID}/`);

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value != null && typeof value === "object" && !Array.isArray(value);

/** `config.json`: the default model and the app-owned provider entry. */
const retireSettings = (settings: Json): boolean => {
  let changed = false;
  if (isRetiredModel(settings.defaultModel)) {
    delete settings.defaultModel;
    changed = true;
  }
  const providers = settings.customProviders;
  if (Array.isArray(providers)) {
    const kept = providers.filter(
      (entry) => !(isObject(entry) && entry.id === RETIRED_PROVIDER_ID)
    );
    if (kept.length !== providers.length) {
      if (kept.length > 0) settings.customProviders = kept;
      else delete settings.customProviders;
      changed = true;
    }
  } else if (isObject(providers) && RETIRED_PROVIDER_ID in providers) {
    // The hand-written shape, keyed by id.
    delete providers[RETIRED_PROVIDER_ID];
    if (Object.keys(providers).length === 0) delete settings.customProviders;
    changed = true;
  }
  return changed;
};

/** Bots and session records: a retired model becomes the app default. */
const retireRecords = (records: unknown[]): number => {
  let count = 0;
  for (const record of records)
    if (isObject(record) && isRetiredModel(record.model)) {
      record.model = null;
      count++;
    }
  return count;
};

interface Target {
  /** Relative to the home. */
  file: string;
  /** Mutates the parsed file in place; true when anything changed. */
  retire(parsed: unknown): boolean;
}

/** The record array at `keys` (electron-store nests dotted keys). */
const recordsAt =
  (...keys: string[]) =>
  (parsed: unknown): boolean => {
    let value = parsed;
    for (const key of keys) value = isObject(value) ? value[key] : undefined;
    return Array.isArray(value) && retireRecords(value) > 0;
  };

const TARGETS = (home: string): Target[] => {
  const accounts = path.join(home, "accounts");
  let stashes: string[] = [];
  try {
    stashes = fs
      .readdirSync(accounts, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join("accounts", entry.name, "sessions.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [
    {
      file: "config.json",
      retire: (parsed) => isObject(parsed) && retireSettings(parsed),
    },
    {
      file: "bots.json",
      retire: (parsed) => Array.isArray(parsed) && retireRecords(parsed) > 0,
    },
    {
      file: "local-code.json",
      retire: recordsAt("localCode", "agentSessions"),
    },
    // A signed-out account's sessions, restored on its next sign-in.
    ...stashes.map((file) => ({ file, retire: recordsAt("records") })),
  ];
};

const planTarget = (
  ctx: MigrationContext,
  target: Target
): PlannedWrite | null => {
  const dest = path.join(ctx.home, target.file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(dest, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Unreadable files are their owners' to repair; nothing to retire here.
    ctx.log(`retire local models: ${target.file} skipped: ${String(error)}`);
    return null;
  }
  if (!target.retire(parsed)) return null;
  const staged = path.join(ctx.staging, target.file);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  // These files hold credentials and session paths; the rename keeps the mode.
  fs.writeFileSync(staged, `${JSON.stringify(parsed, null, 2)}\n`, {
    mode: 0o600,
  });
  return { dest, staged, kind: "replace-user" };
};

export const retireLocalModels = (): MigrationStep => ({
  id: 7,
  name: "retire-local-models",
  plan: async (ctx) => {
    const writes = TARGETS(ctx.home).flatMap(
      (target) => planTarget(ctx, target) ?? []
    );
    return { writes, removals: [], stats: { rewritten: writes.length } };
  },
});

/**
 * The downloaded model files (gigabytes each) under `<home>/models/`, deleted
 * outright rather than backed up. Whisper's files share the folder and stay.
 * Idempotent: after the first launch there is nothing left to match.
 */
export const deleteLocalModelFiles = (
  home: string,
  log: (message: string) => void
): void => {
  const dir = path.join(home, "models");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      log(`local model files not checked: ${String(error)}`);
    return;
  }
  let removed = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/\.gguf(\.part)?$/i.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      bytes += fs.statSync(file).size;
      fs.rmSync(file, { force: true });
      removed++;
    } catch (error) {
      log(`local model file ${entry.name} not removed: ${String(error)}`);
    }
  }
  if (removed === 0) return;
  log(
    `removed ${removed} local model file(s), ${(bytes / 1024 ** 3).toFixed(1)} GB`
  );
  try {
    fs.rmdirSync(dir);
  } catch {
    // Not empty (voice models live here too): the folder stays.
  }
};
