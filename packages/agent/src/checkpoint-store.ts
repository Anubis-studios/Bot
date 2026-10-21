/**
 * Per-turn checkpoints: the bytes every file had before a turn touched it,
 * kept content-addressed under the app's data folder, so any turn can be
 * diffed and undone without git, credits or the agent running. A leaf module
 * (node builtins and atomic-file only): Electron's main process imports it.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { writeFileAtomic } from "./atomic-file.js";

export interface CheckpointLimits {
  /** Files walked per root before the walk stops and the root is partial. */
  maxFilesPerRoot: number;
  /** Bytes copied into the store per root per capture. */
  maxBytesPerRoot: number;
  /** A file above this is tracked by size and time only, never copied. */
  maxFileBytes: number;
  maxTurnsPerSession: number;
  sessionMaxAgeMs: number;
  maxStoreBytes: number;
}

const envNumber = (name: string, fallback: number): number => {
  const parsed = Number((process.env[name] ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export const defaultCheckpointLimits = (): CheckpointLimits => ({
  maxFilesPerRoot: envNumber("ABACUSAI_BOT_CHECKPOINT_MAX_FILES", 5_000),
  maxBytesPerRoot: envNumber(
    "ABACUSAI_BOT_CHECKPOINT_MAX_ROOT_BYTES",
    100 * MB
  ),
  maxFileBytes: envNumber("ABACUSAI_BOT_CHECKPOINT_MAX_FILE_BYTES", 25 * MB),
  maxTurnsPerSession: envNumber("ABACUSAI_BOT_CHECKPOINT_TURNS", 50),
  sessionMaxAgeMs: envNumber("ABACUSAI_BOT_CHECKPOINT_DAYS", 30) * DAY_MS,
  maxStoreBytes: envNumber("ABACUSAI_BOT_CHECKPOINT_STORE_BYTES", 2048 * MB),
});

/** Folders a walk never enters; a file a tool names inside one is still kept. */
export const CHECKPOINT_SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "venv",
  ".venv",
  "__pycache__",
  ".next",
  ".cache",
  ".abacusai-bot",
]);

/** One side of a change. `sha` null: present, but too big or unreadable to keep. */
export interface FileImage {
  sha: string | null;
  size: number;
}

export type ChangeKind = "modified" | "created" | "deleted";

export interface ChangedFile {
  /** Absolute, as this platform spells it. */
  path: string;
  kind: ChangeKind;
  before: FileImage | null;
  after: FileImage | null;
  binary: boolean;
  added: number;
  removed: number;
  /** The before-image was never copied, so this file cannot be put back. */
  unrestorable?: boolean;
}

export interface CheckpointRoot {
  dir: string;
  /** The walk hit a cap; files past it were not kept. */
  partial: boolean;
}

export interface TurnRecord {
  version: 1;
  seq: number;
  /** `restore`: a restore made from the UI, itself undoable. */
  kind: "turn" | "restore";
  /** For a restore: the turn it put back. */
  of?: number;
  /** The user message that started the turn. */
  messageId?: string;
  startedAt: number;
  settledAt: number;
  roots: CheckpointRoot[];
  files: ChangedFile[];
  restoredAt?: number;
  restoredFiles?: string[];
}

export interface TurnSummary {
  seq: number;
  kind: TurnRecord["kind"];
  of?: number;
  messageId?: string;
  settledAt: number;
  added: number;
  removed: number;
  partial: boolean;
  restoredAt?: number;
  files: Array<{
    path: string;
    kind: ChangeKind;
    binary: boolean;
    added: number;
    removed: number;
    unrestorable: boolean;
    restored: boolean;
  }>;
}

export interface FileDiff {
  path: string;
  kind: ChangeKind;
  binary: boolean;
  /** Too large to show, or never copied. */
  omitted: boolean;
  before: string | null;
  after: string | null;
}

export interface RestoreOptions {
  /** Only these files (absolute); all of the turn's otherwise. */
  paths?: readonly string[];
  /** Overwrite files changed after the turn too. */
  force?: boolean;
  /** Record the restore as its own undoable entry (the UI); a turn records itself. */
  record?: boolean;
  /** The caller is the turn holding the lock (the agent's own tool). */
  insideTurn?: boolean;
}

export interface RestoreResult {
  restored: string[];
  /** Changed after the turn; left alone unless forced. */
  conflicts: string[];
  /** No copy was kept, so nothing to put back. */
  unrestorable: string[];
  /** The undoable entry the restore made, when recorded. */
  restoreSeq?: number;
}

export class CheckpointNotFoundError extends Error {
  constructor(what: string) {
    super(`No checkpoint ${what}`);
    this.name = "CheckpointNotFoundError";
  }
}

export class CheckpointBusyError extends Error {
  constructor() {
    super(
      "The agent is still working in this session; wait for the turn to finish."
    );
    this.name = "CheckpointBusyError";
  }
}

/** Session ids become folder names; anything else is refused. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
/** Text above this is not diffed line by line or shown. */
const MAX_DIFF_BYTES = 1 * MB;
const GC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A blob younger than this may belong to a turn still being captured. */
const GC_BLOB_GRACE_MS = 60 * 60 * 1000;
/** A turn lock this old is a crashed process, not a live turn. */
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

/** The checkpoints folder under the app home (ABACUSAI_BOT_HOME, else ~/.abacusai-bot). */
export const checkpointsDirFor = (home: string): string =>
  path.join(home, "checkpoints");

/** The desktop's session id, or a fresh one for a terminal run that has none. */
export const checkpointSessionId = (
  env: NodeJS.ProcessEnv = process.env
): string => {
  const id = (env.ABACUSAI_BOT_SESSION_ID ?? "").trim();
  return SAFE_SESSION_ID.test(id)
    ? id
    : `cli-${process.pid}-${Date.now().toString(36)}`;
};

/** How two spellings of one path compare: case-folded with `/` on Windows. */
export const pathKey = (
  abs: string,
  platform: NodeJS.Platform = process.platform
): string =>
  platform === "win32" ? abs.replace(/\\/g, "/").toLowerCase() : abs;

/**
 * Folders never walked whole: the filesystem root, home and anything above
 * it, and the temp folder. Only the files a call names are kept there.
 */
export function isWalkRefused(
  dir: string,
  home: string,
  temp: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const api = platform === "win32" ? path.win32 : path.posix;
  const key = (p: string): string =>
    pathKey(api.resolve(p), platform).replace(/\/+$/, "");
  const target = key(dir);
  const parsed = api.parse(api.resolve(dir));
  if (parsed.root === api.resolve(dir) || target === "") return true;
  const homeKey = key(home);
  if (target === key(temp)) return true;
  return homeKey === target || homeKey.startsWith(`${target}/`);
}

const isBinary = (bytes: Uint8Array): boolean =>
  bytes.subarray(0, 8000).includes(0);

/** Lines added and removed, counted as multisets: cheap and close for a card. */
export function lineCounts(
  before: string,
  after: string
): { added: number; removed: number } {
  const split = (text: string): string[] =>
    text.length === 0 ? [] : text.replace(/\r\n/g, "\n").split("\n");
  const remaining = new Map<string, number>();
  for (const line of split(before))
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of split(after)) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else added += 1;
  }
  let removed = 0;
  for (const count of remaining.values()) removed += count;
  return { added, removed };
}

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

/** Windows refuses a file another process holds for a moment; try again briefly. */
async function retrying<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 4 || !RETRYABLE_CODES.has(errorCode(error) ?? ""))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
};

export class CheckpointStore {
  readonly dir: string;
  readonly limits: CheckpointLimits;

  constructor(dir: string, limits: Partial<CheckpointLimits> = {}) {
    this.dir = dir;
    this.limits = { ...defaultCheckpointLimits(), ...limits };
  }

  // ------------------------------------------------------------ layout

  blobPath(sha: string): string {
    if (!SHA_RE.test(sha)) throw new Error(`not a checkpoint blob: ${sha}`);
    return path.join(this.dir, "blobs", sha.slice(0, 2), sha);
  }

  sessionDir(sessionId: string): string {
    if (!SAFE_SESSION_ID.test(sessionId))
      throw new CheckpointNotFoundError(`for session ${sessionId}`);
    return path.join(this.dir, "sessions", sessionId);
  }

  private turnPath(sessionId: string, seq: number): string {
    return path.join(this.sessionDir(sessionId), "turns", `${seq}.json`);
  }

  private lockPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "turn.lock");
  }

  statCachePath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "statcache.json");
  }

  // ------------------------------------------------------------ blobs

  async hasBlob(sha: string): Promise<boolean> {
    try {
      await fsp.access(this.blobPath(sha));
      return true;
    } catch {
      return false;
    }
  }

  /** Keep these bytes; returns their hash. Written once, never rewritten. */
  async putBytes(bytes: Uint8Array): Promise<string> {
    const sha = createHash("sha256").update(bytes).digest("hex");
    const target = this.blobPath(sha);
    if (!(await this.hasBlob(sha))) await writeFileAtomic(target, bytes);
    return sha;
  }

  readBlob(sha: string): Promise<Buffer> {
    return fsp.readFile(this.blobPath(sha));
  }

  // ------------------------------------------------------------ turns

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    let names: string[];
    try {
      names = await fsp.readdir(path.join(this.sessionDir(sessionId), "turns"));
    } catch {
      return [];
    }
    const records: TurnRecord[] = [];
    for (const name of names) {
      const seq = Number(name.replace(/\.json$/, ""));
      if (!Number.isInteger(seq) || !name.endsWith(".json")) continue;
      const record = await this.readTurn(sessionId, seq).catch(() => null);
      if (record != null) records.push(record);
    }
    return records.sort((a, b) => a.seq - b.seq);
  }

  async readTurn(sessionId: string, seq: number): Promise<TurnRecord> {
    try {
      const parsed = JSON.parse(
        await fsp.readFile(this.turnPath(sessionId, seq), "utf8")
      ) as TurnRecord;
      if (parsed.version !== 1 || !Array.isArray(parsed.files))
        throw new Error("unknown record");
      return parsed;
    } catch {
      throw new CheckpointNotFoundError(`turn ${seq}`);
    }
  }

  writeTurn(sessionId: string, record: TurnRecord): Promise<void> {
    return writeFileAtomic(
      this.turnPath(sessionId, record.seq),
      JSON.stringify(record)
    );
  }

  /** One past the newest turn on disk or reserved by an open lock. */
  async nextSeq(sessionId: string): Promise<number> {
    const turns = await this.listTurns(sessionId);
    const lock = await this.readLock(sessionId);
    return Math.max(turns.at(-1)?.seq ?? 0, lock?.seq ?? 0) + 1;
  }

  async summaries(sessionId: string): Promise<TurnSummary[]> {
    return (await this.listTurns(sessionId)).map(summarize);
  }

  // ------------------------------------------------------------ the turn lock

  async openTurn(sessionId: string, seq: number): Promise<void> {
    await writeFileAtomic(
      this.lockPath(sessionId),
      JSON.stringify({ pid: process.pid, seq, openedAt: Date.now() })
    );
  }

  async closeTurn(sessionId: string): Promise<void> {
    await fsp.rm(this.lockPath(sessionId), { force: true });
  }

  private async readLock(
    sessionId: string
  ): Promise<{ pid: number; seq: number; openedAt: number } | null> {
    try {
      return JSON.parse(await fsp.readFile(this.lockPath(sessionId), "utf8"));
    } catch {
      return null;
    }
  }

  /** A turn is capturing in this session right now. */
  async turnOpen(sessionId: string): Promise<boolean> {
    const lock = await this.readLock(sessionId);
    return (
      lock != null &&
      Date.now() - lock.openedAt < LOCK_STALE_MS &&
      pidAlive(lock.pid)
    );
  }

  // ------------------------------------------------------------ diff

  async diff(
    sessionId: string,
    seq: number,
    filePath?: string
  ): Promise<FileDiff[]> {
    const record = await this.readTurn(sessionId, seq);
    const files =
      filePath == null
        ? record.files
        : record.files.filter(
            (file) => pathKey(file.path) === pathKey(filePath)
          );
    if (filePath != null && files.length === 0)
      throw new CheckpointNotFoundError(`for ${filePath} in turn ${seq}`);
    const text = async (image: FileImage | null): Promise<string | null> =>
      image?.sha == null
        ? null
        : (await this.readBlob(image.sha)).toString("utf8");
    const diffs: FileDiff[] = [];
    for (const file of files) {
      const tooLarge =
        (file.before?.size ?? 0) > MAX_DIFF_BYTES ||
        (file.after?.size ?? 0) > MAX_DIFF_BYTES;
      const missing =
        (file.before != null && file.before.sha == null) ||
        (file.after != null && file.after.sha == null);
      const omitted = file.binary || tooLarge || missing;
      diffs.push({
        path: file.path,
        kind: file.kind,
        binary: file.binary,
        omitted,
        before: omitted ? null : await text(file.before).catch(() => null),
        after: omitted ? null : await text(file.after).catch(() => null),
      });
    }
    return diffs;
  }

  // ------------------------------------------------------------ restore

  /** What is on disk at `abs` now, hashed only when the size could match. */
  private async current(
    abs: string,
    expected: FileImage | null
  ): Promise<{ image: FileImage | null; bytes: Buffer | null }> {
    let stat: fs.Stats;
    try {
      stat = await fsp.lstat(abs);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR")
        return { image: null, bytes: null };
      throw error;
    }
    if (!stat.isFile())
      return { image: { sha: null, size: stat.size }, bytes: null };
    if (expected?.sha == null || stat.size !== expected.size)
      return { image: { sha: null, size: stat.size }, bytes: null };
    const bytes = await fsp.readFile(abs);
    return {
      image: {
        sha: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      },
      bytes,
    };
  }

  /**
   * Put a turn's files back as they were before it. A file changed after the
   * turn is a conflict, skipped unless forced; one never copied is reported.
   */
  async restore(
    sessionId: string,
    seq: number,
    options: RestoreOptions = {}
  ): Promise<RestoreResult> {
    if (options.insideTurn !== true && (await this.turnOpen(sessionId)))
      throw new CheckpointBusyError();
    const record = await this.readTurn(sessionId, seq);
    const wanted =
      options.paths == null
        ? null
        : new Set(options.paths.map((p) => pathKey(p)));
    const files = record.files.filter(
      (file) => wanted == null || wanted.has(pathKey(file.path))
    );
    if (wanted != null && files.length === 0)
      throw new CheckpointNotFoundError(`for those files in turn ${seq}`);

    const result: RestoreResult = {
      restored: [],
      conflicts: [],
      unrestorable: [],
    };
    const undo: ChangedFile[] = [];
    for (const file of files) {
      if (file.before != null && file.before.sha == null) {
        result.unrestorable.push(file.path);
        continue;
      }
      const now = await this.current(file.path, file.after);
      const untouched =
        file.after == null
          ? now.image == null
          : now.image != null &&
            now.image.sha != null &&
            now.image.sha === file.after.sha;
      if (!untouched && options.force !== true) {
        result.conflicts.push(file.path);
        continue;
      }
      // What is about to be replaced, kept so the restore itself can be undone.
      let replaced: FileImage | null = null;
      if (now.image != null) {
        const bytes =
          now.bytes ?? (await fsp.readFile(file.path).catch(() => null));
        replaced =
          bytes != null && bytes.length <= this.limits.maxFileBytes
            ? { sha: await this.putBytes(bytes), size: bytes.length }
            : { sha: null, size: now.image.size };
      }
      if (file.before == null) {
        await retrying(() => fsp.rm(file.path, { force: true }));
      } else {
        const bytes = await this.readBlob(file.before.sha!);
        await retrying(() => writeFileAtomic(file.path, bytes));
      }
      result.restored.push(file.path);
      undo.push({
        path: file.path,
        kind:
          replaced == null
            ? "created"
            : file.before == null
              ? "deleted"
              : "modified",
        before: replaced,
        after: file.before,
        binary: file.binary,
        added: file.removed,
        removed: file.added,
        ...(replaced != null && replaced.sha == null
          ? { unrestorable: true }
          : {}),
      });
    }

    if (result.restored.length > 0) {
      const restoredAt = Date.now();
      await this.writeTurn(sessionId, {
        ...record,
        restoredAt,
        restoredFiles: [
          ...new Set([...(record.restoredFiles ?? []), ...result.restored]),
        ],
      });
      if (options.record === true) {
        const restoreSeq = await this.nextSeq(sessionId);
        await this.writeTurn(sessionId, {
          version: 1,
          seq: restoreSeq,
          kind: "restore",
          of: seq,
          startedAt: restoredAt,
          settledAt: restoredAt,
          roots: [],
          files: undo,
        });
        result.restoreSeq = restoreSeq;
      }
    }
    return result;
  }

  // ------------------------------------------------------------ retention

  /**
   * Drop old turns and sessions, then blobs nothing refers to. Throttled, and
   * never touches a blob young enough to belong to a capture in flight.
   */
  async collectGarbage(
    keepSession?: string,
    now = Date.now(),
    { force = false }: { force?: boolean } = {}
  ): Promise<void> {
    const stamp = path.join(this.dir, ".gc-stamp");
    if (!force) {
      try {
        if (now - (await fsp.stat(stamp)).mtimeMs < GC_INTERVAL_MS) return;
      } catch {
        // Never collected: go ahead.
      }
    }
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(stamp, String(now));

    const sessionsDir = path.join(this.dir, "sessions");
    const sessions = await fsp.readdir(sessionsDir).catch(() => [] as string[]);
    const live: Array<{ id: string; newest: number }> = [];
    for (const id of sessions) {
      if (!SAFE_SESSION_ID.test(id)) continue;
      const turns = await this.listTurns(id);
      const statMtime = await fsp
        .stat(this.statCachePath(id))
        .then((s) => s.mtimeMs)
        .catch(() => 0);
      const newest = Math.max(turns.at(-1)?.settledAt ?? 0, statMtime);
      if (id !== keepSession && now - newest > this.limits.sessionMaxAgeMs) {
        await fsp.rm(this.sessionDir(id), { recursive: true, force: true });
        continue;
      }
      for (const stale of turns.slice(
        0,
        Math.max(0, turns.length - this.limits.maxTurnsPerSession)
      ))
        await fsp.rm(this.turnPath(id, stale.seq), { force: true });
      live.push({ id, newest });
    }

    let total = await this.sweepBlobs(
      live.map((s) => s.id),
      now
    );
    // Over the store cap: the sessions used longest ago go first.
    for (const session of live.sort((a, b) => a.newest - b.newest)) {
      if (total <= this.limits.maxStoreBytes) break;
      if (session.id === keepSession) continue;
      await fsp.rm(this.sessionDir(session.id), {
        recursive: true,
        force: true,
      });
      total = await this.sweepBlobs(
        live.filter((s) => s !== session).map((s) => s.id),
        now
      );
    }
  }

  /** Delete unreferenced blobs past the grace period; returns the bytes kept. */
  private async sweepBlobs(sessionIds: string[], now: number): Promise<number> {
    const referenced = new Set<string>();
    for (const id of sessionIds) {
      for (const turn of await this.listTurns(id)) {
        for (const file of turn.files) {
          if (file.before?.sha) referenced.add(file.before.sha);
          if (file.after?.sha) referenced.add(file.after.sha);
        }
      }
      for (const entry of Object.values(await readStatCache(this, id)))
        if (entry.sha) referenced.add(entry.sha);
    }
    let total = 0;
    const blobsDir = path.join(this.dir, "blobs");
    for (const prefix of await fsp
      .readdir(blobsDir)
      .catch(() => [] as string[])) {
      const folder = path.join(blobsDir, prefix);
      for (const name of await fsp
        .readdir(folder)
        .catch(() => [] as string[])) {
        const file = path.join(folder, name);
        const stat = await fsp.stat(file).catch(() => null);
        if (stat == null) continue;
        if (!referenced.has(name) && now - stat.mtimeMs > GC_BLOB_GRACE_MS)
          await fsp.rm(file, { force: true });
        else total += stat.size;
      }
    }
    return total;
  }
}

function summarize(record: TurnRecord): TurnSummary {
  const restored = new Set((record.restoredFiles ?? []).map((p) => pathKey(p)));
  return {
    seq: record.seq,
    kind: record.kind,
    ...(record.of != null ? { of: record.of } : {}),
    ...(record.messageId != null ? { messageId: record.messageId } : {}),
    settledAt: record.settledAt,
    added: record.files.reduce((sum, file) => sum + file.added, 0),
    removed: record.files.reduce((sum, file) => sum + file.removed, 0),
    partial: record.roots.some((root) => root.partial),
    ...(record.restoredAt != null ? { restoredAt: record.restoredAt } : {}),
    files: record.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      binary: file.binary,
      added: file.added,
      removed: file.removed,
      unrestorable:
        file.unrestorable === true ||
        (file.before != null && file.before.sha == null),
      restored: restored.has(pathKey(file.path)),
    })),
  };
}

// -------------------------------------------------------------- capture

/** What one file looked like when last seen; `sha` absent until hashed. */
interface FileState {
  size: number;
  mtimeMs: number;
  sha?: string | null;
}

/** `seenAt`: when it was hashed; a file touched that close to it may have changed since. */
type StatCache = Record<string, { path: string; seenAt?: number } & FileState>;

/**
 * Filesystem timestamps are coarse: a same-size rewrite inside one tick leaves
 * size and time alike. Within this of the moment of looking, hash anyway.
 */
const RACY_MS = 2_000;

async function readStatCache(
  store: CheckpointStore,
  sessionId: string
): Promise<StatCache> {
  try {
    return JSON.parse(
      await fsp.readFile(store.statCachePath(sessionId), "utf8")
    );
  } catch {
    return {};
  }
}

export interface CaptureTarget {
  path: string;
  /** `file`: exactly this file. `dir`: everything under it, within the caps. */
  kind: "file" | "dir";
}

export interface CaptureOutcome {
  /** Files a call names that could not be kept. */
  failed: Array<{ path: string; reason: string }>;
}

interface Seen {
  path: string;
  state: FileState | null;
}

interface TrackerOptions {
  platform?: NodeJS.Platform;
  home?: string;
  temp?: string;
}

/**
 * One session's capture. A window opens at a turn's first mutating call and
 * closes when the run settles: before it, every file in the roots the turn
 * reached is kept; at the close, what changed becomes the turn's record.
 */
export class CheckpointTracker {
  readonly store: CheckpointStore;
  readonly sessionId: string;
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly temp: string;

  private turn: { messageId?: string; startedAt: number; seq: number | null } =
    {
      startedAt: Date.now(),
      seq: null,
    };
  private window: {
    pre: Map<string, Seen>;
    roots: Map<string, CheckpointRoot>;
    openedAt: number;
  } | null = null;
  /** Last state seen per file, for the size-and-time short cut and per-call diffs. */
  private known = new Map<string, Seen>();
  private statCache: StatCache | null = null;
  private lastSettled: ChangedFile[] = [];
  private lastCall: string[] = [];

  constructor(
    store: CheckpointStore,
    sessionId: string,
    options: TrackerOptions = {}
  ) {
    this.store = store;
    this.sessionId = sessionId;
    this.platform = options.platform ?? process.platform;
    this.home = options.home ?? os.homedir();
    this.temp = options.temp ?? os.tmpdir();
  }

  private key(abs: string): string {
    return pathKey(abs, this.platform);
  }

  /** A new user turn: what settles from here on is a new record. */
  beginTurn(messageId?: string): void {
    this.turn = {
      ...(messageId != null ? { messageId } : {}),
      startedAt: Date.now(),
      seq: null,
    };
  }

  /** The changes the last settled run made (not merged with earlier runs). */
  settledChanges(): readonly ChangedFile[] {
    return this.lastSettled;
  }

  /** Files the last `afterCall` found changed. */
  changedByLastCall(): readonly string[] {
    return this.lastCall;
  }

  private async openWindow(): Promise<void> {
    if (this.window != null) return;
    if (this.turn.seq == null)
      this.turn.seq = await this.store.nextSeq(this.sessionId);
    this.window = {
      pre: new Map(),
      roots: new Map(),
      openedAt: Date.now(),
    };
    this.statCache ??= await readStatCache(this.store, this.sessionId);
    await this.store.openTurn(this.sessionId, this.turn.seq);
  }

  private coveredByRoot(abs: string): boolean {
    const target = this.key(abs);
    for (const root of this.window!.roots.values()) {
      const dir = this.key(root.dir).replace(/\/+$/, "");
      if (target === dir || target.startsWith(`${dir}/`)) return true;
    }
    return false;
  }

  /**
   * Regular files under `dir` in a fixed order, skipping the heavy folders and
   * the store itself; stops at the file cap.
   */
  private async walk(dir: string): Promise<{
    files: Array<{ path: string; stat: fs.Stats }>;
    partial: boolean;
  }> {
    const files: Array<{ path: string; stat: fs.Stats }> = [];
    const storeKey = this.key(this.store.dir);
    const max = this.store.limits.maxFilesPerRoot;
    let partial = false;
    const visit = async (folder: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(folder, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (files.length >= max) {
          partial = true;
          return;
        }
        const child = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          if (CHECKPOINT_SKIPPED_DIRS.has(entry.name)) continue;
          if (this.key(child) === storeKey) continue;
          await visit(child);
        } else if (entry.isFile()) {
          const stat = await fsp.lstat(child).catch(() => null);
          if (stat?.isFile()) files.push({ path: child, stat });
        }
      }
    };
    await visit(dir);
    return { files, partial };
  }

  /**
   * Keep one file's current bytes, unless the size-and-time short cut says
   * the store already has them. `budget` is the root's remaining byte cap.
   */
  private async keep(
    abs: string,
    stat: fs.Stats,
    budget: { left: number } | null
  ): Promise<FileState> {
    const state: FileState = { size: stat.size, mtimeMs: stat.mtimeMs };
    const cached = this.statCache?.[this.key(abs)];
    if (
      cached?.sha != null &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.seenAt != null &&
      stat.mtimeMs < cached.seenAt - RACY_MS &&
      (await this.store.hasBlob(cached.sha))
    )
      return { ...state, sha: cached.sha };
    if (stat.size > this.store.limits.maxFileBytes)
      return { ...state, sha: null };
    if (budget != null && budget.left < stat.size)
      return { ...state, sha: null };
    const bytes = await fsp.readFile(abs);
    if (budget != null) budget.left -= bytes.length;
    const sha = await this.store.putBytes(bytes);
    this.rememberStat(abs, { size: bytes.length, mtimeMs: stat.mtimeMs, sha });
    return { size: bytes.length, mtimeMs: stat.mtimeMs, sha };
  }

  private rememberStat(abs: string, state: FileState): void {
    if (state.sha == null || this.statCache == null) return;
    this.statCache[this.key(abs)] = { path: abs, ...state, seenAt: Date.now() };
  }

  /** Before a mutating call: keep every file it could touch that this window has not. */
  async capture(targets: readonly CaptureTarget[]): Promise<CaptureOutcome> {
    await this.openWindow();
    const window = this.window!;
    const outcome: CaptureOutcome = { failed: [] };

    for (const target of targets) {
      const abs = path.resolve(target.path);
      if (target.kind === "file") {
        const key = this.key(abs);
        const seen = window.pre.get(key);
        if (seen != null) {
          // Walked already, but past a cap: the file this call names must be kept.
          if (seen.state != null && seen.state.sha == null) {
            const stat = await fsp.lstat(abs).catch(() => null);
            const state = stat?.isFile()
              ? await this.keep(abs, stat, null).catch(() => null)
              : null;
            if (state?.sha != null) seen.state = state;
            else
              outcome.failed.push({
                path: abs,
                reason: `it is larger than ${Math.round(this.store.limits.maxFileBytes / MB)} MB`,
              });
          }
          continue;
        }
        try {
          const stat = await fsp.lstat(abs).catch((error) => {
            if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR")
              return null;
            throw error;
          });
          if (stat != null && !stat.isFile()) continue;
          const state = stat == null ? null : await this.keep(abs, stat, null);
          if (state != null && state.sha == null)
            outcome.failed.push({
              path: abs,
              reason: `it is larger than ${Math.round(this.store.limits.maxFileBytes / MB)} MB`,
            });
          window.pre.set(key, { path: abs, state });
          this.known.set(key, { path: abs, state });
        } catch (error) {
          outcome.failed.push({
            path: abs,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }

      if (
        this.coveredByRoot(abs) ||
        isWalkRefused(abs, this.home, this.temp, this.platform)
      )
        continue;
      const stat = await fsp.stat(abs).catch(() => null);
      if (stat == null || !stat.isDirectory()) continue;
      const root: CheckpointRoot = { dir: abs, partial: false };
      window.roots.set(this.key(abs), root);
      const { files, partial } = await this.walk(abs);
      root.partial = partial;
      const budget = { left: this.store.limits.maxBytesPerRoot };
      for (const file of files) {
        const key = this.key(file.path);
        if (window.pre.has(key)) continue;
        let state: FileState;
        try {
          state = await this.keep(file.path, file.stat, budget);
        } catch {
          state = {
            size: file.stat.size,
            mtimeMs: file.stat.mtimeMs,
            sha: null,
          };
        }
        if (state.sha == null) root.partial = true;
        window.pre.set(key, { path: file.path, state });
        this.known.set(key, { path: file.path, state });
      }
    }
    return outcome;
  }

  /** After a call: which files under these targets changed, by size and time. */
  async afterCall(
    targets: readonly CaptureTarget[]
  ): Promise<readonly string[]> {
    const changed: string[] = [];
    this.lastCall = changed;
    const window = this.window;
    const look = async (abs: string, stat: fs.Stats | null): Promise<void> => {
      const key = this.key(abs);
      const before = this.known.get(key)?.state ?? null;
      const now: FileState | null =
        stat == null ? null : { size: stat.size, mtimeMs: stat.mtimeMs };
      const same =
        before == null
          ? now == null
          : now != null &&
            before.size === now.size &&
            before.mtimeMs === now.mtimeMs;
      if (same) return;
      changed.push(abs);
      // Made during this window: absent before it.
      if (window != null && !window.pre.has(key) && before == null)
        window.pre.set(key, { path: abs, state: null });
      this.known.set(key, { path: abs, state: now });
    };

    for (const target of targets) {
      const abs = path.resolve(target.path);
      if (target.kind === "file") {
        await look(abs, await fsp.lstat(abs).catch(() => null));
        continue;
      }
      if (window == null || !window.roots.has(this.key(abs))) continue;
      const { files } = await this.walk(abs);
      const seen = new Set<string>();
      for (const file of files) {
        seen.add(this.key(file.path));
        await look(file.path, file.stat);
      }
      const prefix = `${this.key(abs).replace(/\/+$/, "")}/`;
      for (const [key, entry] of this.known) {
        if (seen.has(key) || entry.state == null) continue;
        if (!key.startsWith(prefix)) continue;
        const stat = await fsp.lstat(entry.path).catch(() => null);
        if (stat == null) await look(entry.path, null);
      }
    }
    this.lastCall = changed;
    return changed;
  }

  /** The run settled: what changed since the window opened becomes the turn's record. */
  async settle(): Promise<TurnRecord | null> {
    const window = this.window;
    this.window = null;
    if (window == null || this.turn.seq == null) {
      this.lastSettled = [];
      return null;
    }
    try {
      const post = new Map<string, Seen>();
      for (const root of window.roots.values()) {
        const { files } = await this.walk(root.dir);
        for (const file of files) {
          const key = this.key(file.path);
          if (!window.pre.has(key))
            window.pre.set(key, { path: file.path, state: null });
          post.set(key, {
            path: file.path,
            state: { size: file.stat.size, mtimeMs: file.stat.mtimeMs },
          });
        }
      }
      // Files the walk did not reach (named outright, or past a cap) are looked at directly.
      for (const [key, seen] of window.pre) {
        if (post.has(key)) continue;
        const stat = await fsp.lstat(seen.path).catch(() => null);
        post.set(key, {
          path: seen.path,
          state:
            stat?.isFile() === true
              ? { size: stat.size, mtimeMs: stat.mtimeMs }
              : null,
        });
      }

      const changes: ChangedFile[] = [];
      for (const [key, before] of window.pre) {
        const after = post.get(key)!;
        const change = await this.compare(before, after, window.openedAt);
        this.known.set(key, after);
        if (change != null) changes.push(change);
      }
      changes.sort((a, b) => (a.path < b.path ? -1 : 1));
      this.lastSettled = changes;

      const record = await this.merge(window, changes);
      if (this.statCache != null)
        await writeFileAtomic(
          this.store.statCachePath(this.sessionId),
          JSON.stringify(this.statCache)
        );
      return record;
    } finally {
      await this.store.closeTurn(this.sessionId).catch(() => {});
    }
  }

  /** One file's change across the window, or null when it ended as it began. */
  private async compare(
    before: Seen,
    after: Seen,
    openedAt: number
  ): Promise<ChangedFile | null> {
    const pre = before.state;
    const post = after.state;
    if (pre == null && post == null) return null;
    if (
      pre != null &&
      post != null &&
      pre.size === post.size &&
      pre.mtimeMs === post.mtimeMs &&
      (post.mtimeMs < openedAt - RACY_MS || pre.sha == null)
    ) {
      post.sha = pre.sha;
      return null;
    }
    let afterBytes: Buffer | null = null;
    if (post != null) {
      if (post.size <= this.store.limits.maxFileBytes) {
        afterBytes = await fsp.readFile(after.path).catch(() => null);
        post.sha =
          afterBytes == null ? null : await this.store.putBytes(afterBytes);
        if (afterBytes != null) post.size = afterBytes.length;
        this.rememberStat(after.path, post);
      } else post.sha = null;
    }
    if (pre != null && post != null && pre.sha != null && pre.sha === post.sha)
      return null;
    const beforeBytes =
      pre?.sha != null
        ? await this.store.readBlob(pre.sha).catch(() => null)
        : null;
    const binary =
      (beforeBytes != null && isBinary(beforeBytes)) ||
      (afterBytes != null && isBinary(afterBytes));
    const counted =
      !binary &&
      (pre == null || beforeBytes != null) &&
      (post == null || afterBytes != null) &&
      (pre?.size ?? 0) <= MAX_DIFF_BYTES &&
      (post?.size ?? 0) <= MAX_DIFF_BYTES
        ? lineCounts(
            beforeBytes?.toString("utf8") ?? "",
            afterBytes?.toString("utf8") ?? ""
          )
        : { added: 0, removed: 0 };
    return {
      path: before.path,
      kind: pre == null ? "created" : post == null ? "deleted" : "modified",
      before: pre == null ? null : { sha: pre.sha ?? null, size: pre.size },
      after: post == null ? null : { sha: post.sha ?? null, size: post.size },
      binary,
      ...counted,
      ...(pre != null && pre.sha == null ? { unrestorable: true } : {}),
    };
  }

  /**
   * A follow-up run in the same turn adds to its record: the earliest
   * before-image and the latest after-image, and a file back where it began drops out.
   */
  private async merge(
    window: NonNullable<CheckpointTracker["window"]>,
    changes: ChangedFile[]
  ): Promise<TurnRecord | null> {
    const seq = this.turn.seq!;
    const existing = await this.store
      .readTurn(this.sessionId, seq)
      .catch(() => null);
    const byKey = new Map<string, ChangedFile>();
    for (const file of existing?.files ?? [])
      byKey.set(this.key(file.path), file);
    for (const change of changes) {
      const earlier = byKey.get(this.key(change.path));
      if (earlier == null) {
        byKey.set(this.key(change.path), change);
        continue;
      }
      const before = earlier.before;
      const after = change.after;
      const same =
        (before == null && after == null) ||
        (before?.sha != null && before.sha === after?.sha);
      if (same) {
        byKey.delete(this.key(change.path));
        continue;
      }
      byKey.set(this.key(change.path), {
        ...change,
        kind:
          before == null ? "created" : after == null ? "deleted" : "modified",
        before,
        added: earlier.added + change.added,
        removed: earlier.removed + change.removed,
        binary: earlier.binary || change.binary,
        ...(earlier.unrestorable === true ? { unrestorable: true } : {}),
      });
    }
    const files = [...byKey.values()].sort((a, b) =>
      a.path < b.path ? -1 : 1
    );
    if (files.length === 0) {
      if (existing != null)
        await fsp.rm(
          path.join(
            this.store.sessionDir(this.sessionId),
            "turns",
            `${seq}.json`
          ),
          {
            force: true,
          }
        );
      return null;
    }
    const roots = new Map<string, CheckpointRoot>();
    for (const root of [...(existing?.roots ?? []), ...window.roots.values()])
      roots.set(this.key(root.dir), {
        dir: root.dir,
        partial:
          root.partial || (roots.get(this.key(root.dir))?.partial ?? false),
      });
    const record: TurnRecord = {
      version: 1,
      seq,
      kind: "turn",
      ...(this.turn.messageId != null
        ? { messageId: this.turn.messageId }
        : {}),
      startedAt: existing?.startedAt ?? this.turn.startedAt,
      settledAt: Date.now(),
      roots: [...roots.values()],
      files,
    };
    await this.store.writeTurn(this.sessionId, record);
    return record;
  }
}
