/**
 * The agent shell's deletes, sent to the Recycle Bin / Trash.
 *
 * trash.ts puts a directory of launchers first on the agent shell's PATH;
 * each runs this file with the command it stands in for. `rm`, `rmdir`,
 * `unlink`, `find -delete`, `git clean`, cmd's `del`/`rd` and PowerShell's
 * `Remove-Item` hand what they would delete to the agent, which moves it to
 * the platform's trash. A delete is never refused: when the move fails, the
 * real tool deletes it and a note says so. Deleting the trash itself, or
 * anything inside it, is the one thing never run.
 *
 * Node builtins only, and no imports of the agent: it starts once per command.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/** What the agent hands the launchers, and they this file. */
export const TRASH_ENV = {
  socket: "ABACUSAI_BOT_TRASH_SOCKET",
  token: "ABACUSAI_BOT_TRASH_TOKEN",
  /** The launcher directory, skipped when the real tool is looked up. */
  shims: "ABACUSAI_BOT_TRASH_SHIMS",
  /** Windows: the busybox applet launchers, which are the real rm and find there. */
  applets: "ABACUSAI_BOT_TRASH_APPLETS",
  /** The runtime and this file, for the cmd and PowerShell rewrites to call back. */
  node: "ABACUSAI_BOT_TRASH_NODE",
  entry: "ABACUSAI_BOT_TRASH_ENTRY",
} as const;

/** The commands that get a launcher. */
export const TRASH_SHIMMED = [
  "rm",
  "rmdir",
  "unlink",
  "find",
  "git",
  "cmd",
  "powershell",
  "pwsh",
] as const;

/** Busybox applets ash must look up on PATH (BB_OVERRIDE_APPLETS) so the launchers win. */
export const TRASH_APPLETS = ["rm", "rmdir", "unlink", "find"] as const;

export function trashName(
  platform: NodeJS.Platform = process.platform
): string {
  return platform === "win32" ? "Recycle Bin" : "Trash";
}

/** Model-facing; the model relays it in the user's language. */
export function emptyTrashMessage(
  platform: NodeJS.Platform = process.platform
): string {
  const bin = trashName(platform);

  return (
    `Not run: this empties the ${bin} or deletes from it, which can't be undone, so the agent never does it. ` +
    `Tell the user, in their language: "Emptying the ${bin} can't be undone, so I won't do it. ` +
    `Please open the ${bin} yourself, check nothing in it is needed, then empty it."`
  );
}

const foldCase = (platform: NodeJS.Platform): boolean =>
  platform === "win32" || platform === "darwin";

const pathFor = (platform: NodeJS.Platform): typeof path.posix =>
  platform === "win32" ? path.win32 : path.posix;

/** The per-user trash a path's spelling cannot show (Linux's may be anywhere); none on Windows. */
function homeTrash(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string | null {
  const lib = pathFor(platform);
  if (platform === "win32") return null;
  if (platform === "darwin") return lib.join(os.homedir(), ".Trash");
  const data = (env.XDG_DATA_HOME ?? "").trim();

  return lib.join(
    data.length > 0 ? data : lib.join(os.homedir(), ".local", "share"),
    "Trash"
  );
}

const TRASH_SEGMENT = /^(?:\.trash(?:es)?|\.trash-\d+|\$recycle\.bin)$/i;

/** The path with its directory's links resolved, so a link into the trash counts as the trash. */
function realParent(abs: string): string {
  try {
    return path.join(
      fs.realpathSync.native(path.dirname(abs)),
      path.basename(abs)
    );
  } catch {
    return abs;
  }
}

function within(
  child: string,
  parent: string,
  platform: NodeJS.Platform
): boolean {
  const lib = pathFor(platform);
  const fold = foldCase(platform);
  const rel = lib.relative(
    fold ? parent.toLowerCase() : parent,
    fold ? child.toLowerCase() : child
  );

  return rel === "" || (!rel.startsWith("..") && !lib.isAbsolute(rel));
}

/**
 * Whether deleting `abs` would delete from a trash: it is one, is inside one,
 * or holds one (a home folder, a drive root).
 */
export function touchesTrash(
  abs: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  const lib = pathFor(platform);
  const resolved = lib.resolve(abs);
  const candidates = new Set([resolved]);
  if (platform === process.platform) candidates.add(realParent(resolved));
  const own = homeTrash(env, platform);
  for (const candidate of candidates) {
    const segments = candidate.split(/[\\/]+/).filter((s) => s.length > 0);
    if (segments.some((segment) => TRASH_SEGMENT.test(segment))) return true;
    // The XDG trash's own name, whoever's home it is in.
    if (/(?:^|[\\/])\.local[\\/]share[\\/]trash(?:[\\/]|$)/i.test(candidate))
      return true;
    // Windows XP's name for it, at the root of a drive.
    if (platform === "win32" && /^recycler$/i.test(segments[1] ?? ""))
      return true;
    if (lib.parse(candidate).root === candidate) return true;
    if (platform === "darwin" && /^\/Volumes\/[^/]+\/?$/.test(candidate))
      return true;
    if (
      own != null &&
      (within(candidate, own, platform) || within(own, candidate, platform))
    )
      return true;
  }

  return false;
}

/** Scratch space: deletes there are plain deletes, or every build would fill the trash. */
function tempRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = new Set<string>();
  for (const dir of [os.tmpdir(), env.TMPDIR, env.TEMP, env.TMP, "/tmp"]) {
    if (dir == null || dir.length === 0) continue;
    try {
      roots.add(fs.realpathSync.native(dir));
    } catch {
      // Not on this machine.
    }
  }

  return [...roots];
}

export function inTemp(
  abs: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  const real = realParent(path.resolve(abs));

  return tempRoots(env).some(
    (root) => real !== root && within(real, root, platform)
  );
}

/**
 * Asks the agent to move each path to the trash. Null for a path that went;
 * otherwise why not, which is every path when the agent cannot be reached.
 */
export async function sendToTrash(
  paths: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<Array<string | null>> {
  const socket = env[TRASH_ENV.socket];
  const token = env[TRASH_ENV.token];
  if (paths.length === 0) return [];
  if (socket == null || socket === "" || token == null || token === "")
    return paths.map(() => "the app's trash service is not available here");

  return await new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (results: Array<string | null>): void => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(results);
    };
    const client = net.createConnection(socket, () => {
      client.write(`${JSON.stringify({ token, paths })}\n`);
    });
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, end)) as {
          results?: Array<string | null>;
        };
        const results = reply.results ?? [];
        finish(
          paths.map((_, index) =>
            results[index] === undefined ? "no answer" : results[index]!
          )
        );
      } catch {
        finish(paths.map(() => "an unreadable answer from the app"));
      }
    });
    const unreachable = (): void =>
      finish(paths.map(() => "the app's trash service could not be reached"));
    client.on("error", unreachable);
    client.on("close", unreachable);
  });
}

/** Where the real `name` is: the busybox applet on Windows, else PATH without the launchers. */
export function realTool(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  const applets = env[TRASH_ENV.applets];
  if (
    platform === "win32" &&
    applets != null &&
    applets !== "" &&
    (TRASH_APPLETS as readonly string[]).includes(name)
  ) {
    const applet = path.join(applets, `${name}.exe`);
    if (fs.existsSync(applet)) return applet;
  }
  const fold = foldCase(platform);
  const shims = env[TRASH_ENV.shims] ?? "";
  const same = (a: string, b: string): boolean => {
    try {
      a = fs.realpathSync.native(a);
      b = fs.realpathSync.native(b);
    } catch {
      // Compared as spelled.
    }
    return fold ? a.toLowerCase() === b.toLowerCase() : a === b;
  };
  const pathValue =
    Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ??
    "";
  const extensions =
    platform === "win32" ? [".exe", ".com", ".cmd", ".bat"] : [""];
  for (const dir of pathValue.split(platform === "win32" ? ";" : ":")) {
    if (dir.length === 0 || (shims !== "" && same(dir, shims))) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      try {
        const info = fs.statSync(candidate);
        if (!info.isFile()) continue;
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Not here.
      }
    }
  }
  if (platform === "win32") {
    const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    const known: Record<string, string> = {
      cmd: path.join(root, "System32", "cmd.exe"),
      powershell: path.join(
        root,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      ),
    };
    if (known[name] != null && fs.existsSync(known[name]!)) return known[name]!;
  }

  return null;
}

/** Runs the real tool on our own stdio; its exit status, 127 when there is none. */
function runReal(
  name: string,
  args: readonly string[],
  options: { windowsVerbatimArguments?: boolean } = {}
): number {
  const real = realTool(name);
  if (real == null) {
    process.stderr.write(`${name}: command not found\n`);
    return 127;
  }
  const result = spawnSync(real, args, {
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  if (result.error != null) {
    process.stderr.write(`${name}: ${result.error.message}\n`);
    return 126;
  }

  return result.status ?? 1;
}

/** One item a command would delete, as the user spelled it and resolved. */
interface Target {
  shown: string;
  abs: string;
}

/** How a command deletes what the trash cannot take. */
type PlainDelete = (targets: readonly Target[]) => number;

const removeTree: PlainDelete = (targets) => {
  let status = 0;
  for (const target of targets) {
    try {
      fs.rmSync(target.abs, { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(
        `could not delete '${target.shown}': ${(error as Error).message}\n`
      );
      status = 1;
    }
  }
  return status;
};

/**
 * Trash what can go, plain-delete temp files and whatever the trash refused
 * (saying so), and refuse only what is in the trash. The exit status.
 */
async function dispose(
  tool: string,
  targets: readonly Target[],
  plain: PlainDelete,
  onTrashed: (target: Target) => void = () => {}
): Promise<number> {
  let status = 0;
  const blocked = targets.filter((target) => touchesTrash(target.abs));
  if (blocked.length > 0) {
    process.stderr.write(`${tool}: ${emptyTrashMessage()}\n`);
    status = 1;
  }
  const rest = targets.filter((target) => !blocked.includes(target));
  const scratch = rest.filter((target) => inTemp(target.abs));
  const keep = rest.filter((target) => !scratch.includes(target));
  const reasons = await sendToTrash(keep.map((target) => target.abs));
  const failed: Target[] = [];
  keep.forEach((target, index) => {
    const reason = reasons[index];
    if (reason == null) {
      onTrashed(target);
      return;
    }
    process.stderr.write(
      `${tool}: could not move '${target.shown}' to the ${trashName()} (${reason}); deleted it permanently instead.\n`
    );
    failed.push(target);
  });
  const fallback = [...scratch, ...failed];
  if (fallback.length > 0) status = Math.max(status, plain(fallback));

  return status;
}

const resolveTarget = (shown: string, cwd = process.cwd()): Target => ({
  shown,
  abs: path.resolve(cwd, shown),
});

function lstat(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

function isEmptyDir(file: string): boolean {
  try {
    return fs.readdirSync(file).length === 0;
  } catch {
    return false;
  }
}

/** `rm`, the common GNU, BSD and busybox options. Null: an option we do not know, left to the real rm. */
export function parseRm(args: readonly string[]): {
  recursive: boolean;
  force: boolean;
  dir: boolean;
  verbose: boolean;
  operands: string[];
} | null {
  const flags = { recursive: false, force: false, dir: false, verbose: false };
  const operands: string[] = [];
  let options = true;
  for (const arg of args) {
    if (!options || arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      options = false;
      continue;
    }
    if (arg.startsWith("--")) {
      const name = arg.split("=")[0]!;
      if (name === "--recursive") flags.recursive = true;
      else if (name === "--force") flags.force = true;
      else if (name === "--dir") flags.dir = true;
      else if (name === "--verbose") flags.verbose = true;
      else if (
        ![
          "--interactive",
          "--one-file-system",
          "--preserve-root",
          "--no-preserve-root",
        ].includes(name)
      )
        return null;
      continue;
    }
    for (const letter of arg.slice(1)) {
      if (letter === "r" || letter === "R") flags.recursive = true;
      else if (letter === "f") flags.force = true;
      else if (letter === "d") flags.dir = true;
      else if (letter === "v") flags.verbose = true;
      else if (!"iIPx".includes(letter)) return null;
    }
  }

  return { ...flags, operands };
}

async function rm(args: readonly string[]): Promise<number> {
  const parsed = parseRm(args);
  if (parsed == null) return runReal("rm", args);
  let status = 0;
  const targets: Target[] = [];
  for (const operand of parsed.operands) {
    const target = resolveTarget(operand);
    const info = lstat(target.abs);
    const base = path.basename(operand.replace(/[\\/]+$/, ""));
    if (base === "." || base === "..") {
      process.stderr.write(
        `rm: refusing to remove '.' or '..' directory: skipping '${operand}'\n`
      );
      status = 1;
    } else if (info == null) {
      if (!parsed.force) {
        process.stderr.write(
          `rm: cannot remove '${operand}': No such file or directory\n`
        );
        status = 1;
      }
    } else if (info.isDirectory() && !parsed.recursive) {
      if (parsed.dir && isEmptyDir(target.abs)) targets.push(target);
      else {
        process.stderr.write(
          `rm: cannot remove '${operand}': ${parsed.dir ? "Directory not empty" : "Is a directory"}\n`
        );
        status = 1;
      }
    } else targets.push(target);
  }
  const done = await dispose("rm", targets, removeTree, (target) => {
    if (parsed.verbose) process.stdout.write(`removed '${target.shown}'\n`);
  });

  return Math.max(status, done);
}

async function rmdir(args: readonly string[]): Promise<number> {
  let parents = false;
  let ignoreNonEmpty = false;
  const operands: string[] = [];
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") options = false;
    else if (options && (arg === "-p" || arg === "--parents")) parents = true;
    else if (options && arg === "--ignore-fail-on-non-empty")
      ignoreNonEmpty = true;
    else if (options && (arg === "-v" || arg === "--verbose")) continue;
    else if (options && arg.startsWith("-") && arg !== "-")
      return runReal("rmdir", args);
    else operands.push(arg);
  }
  let status = 0;
  for (const operand of operands) {
    const chain = [operand];
    if (parents) {
      let parent = path.dirname(operand);
      while (parent !== "." && parent !== path.dirname(parent)) {
        chain.push(parent);
        parent = path.dirname(parent);
      }
    }
    for (const step of chain) {
      const target = resolveTarget(step);
      const info = lstat(target.abs);
      if (info?.isDirectory() !== true || !isEmptyDir(target.abs)) {
        // The real rmdir says why: missing, not a directory, not empty.
        if (!(ignoreNonEmpty && info?.isDirectory() === true))
          status = Math.max(status, runReal("rmdir", ["--", step]));
        break;
      }
      const done = await dispose("rmdir", [target], (left) =>
        Math.max(0, ...left.map((item) => runReal("rmdir", ["--", item.abs])))
      );
      status = Math.max(status, done);
      if (done !== 0) break;
    }
  }

  return status;
}

async function unlink(args: readonly string[]): Promise<number> {
  const operands = args[0] === "--" ? args.slice(1) : args;
  if (operands.length !== 1 || operands[0]!.startsWith("-"))
    return runReal("unlink", args);
  const target = resolveTarget(operands[0]!);
  const info = lstat(target.abs);
  if (info == null || info.isDirectory()) return runReal("unlink", args);

  return await dispose("unlink", [target], (left) =>
    Math.max(0, ...left.map((item) => runReal("unlink", ["--", item.abs])))
  );
}

/** Every entry under `dir` is in `matched`, so the folder can go to the trash whole. */
function wholeTreeMatched(
  dir: string,
  matched: ReadonlySet<string>,
  budget = { left: 100_000 }
): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (--budget.left < 0) return false;
    const child = path.join(dir, entry.name);
    if (!matched.has(child)) return false;
    if (
      entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      !wholeTreeMatched(child, matched, budget)
    )
      return false;
  }
  return true;
}

/**
 * `find … -delete`: the real find lists what it would delete (each `-delete`
 * becomes an `-exec` that records its paths), then whole matched folders go
 * to the trash as one item and the rest one by one, deepest folders last.
 */
async function find(args: readonly string[]): Promise<number> {
  if (!args.includes("-delete")) return runReal("find", args);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-find-"));
  const list = path.join(scratch, "matches");
  fs.writeFileSync(list, "");
  try {
    const rewritten = args.flatMap((arg) =>
      arg === "-delete"
        ? ["-exec", "sh", "-c", 'printf "%s\\0" "$@" >> "$0"', list, "{}", "+"]
        : [arg]
    );
    const found = runReal("find", rewritten);
    const shown = new Map<string, string>();
    for (const entry of fs.readFileSync(list, "utf8").split("\0")) {
      if (entry.length > 0) shown.set(path.resolve(entry), entry);
    }
    const matched = new Set(shown.keys());
    const ordered = [...matched].sort(
      (a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length
    );
    const handled = new Set<string>();
    const covered = (file: string): boolean => {
      for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
        if (handled.has(dir)) return true;
        if (dir === path.dirname(dir)) return false;
      }
    };
    const now: Target[] = [];
    const later: Target[] = [];
    for (const abs of ordered) {
      if (covered(abs)) continue;
      const info = lstat(abs);
      if (info == null) continue;
      const target = { shown: shown.get(abs)!, abs };
      if (info.isDirectory() && !wholeTreeMatched(abs, matched)) {
        later.push(target);
        continue;
      }
      handled.add(abs);
      now.push(target);
    }
    let status = Math.max(found, await dispose("find", now, removeTree));
    // Folders with something unmatched left in them: find deletes those only once empty.
    for (const target of later.reverse()) {
      if (!isEmptyDir(target.abs)) {
        process.stderr.write(
          `find: cannot delete '${target.shown}': Directory not empty\n`
        );
        status = Math.max(status, 1);
        continue;
      }
      status = Math.max(status, await dispose("find", [target], removeTree));
    }

    return status;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** git's options that take the next argument as their value. */
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--exec-path",
  "--list-cmds",
  "--attr-source",
]);

/**
 * `git clean` with force and without -n/-i: the same clean, dry run, says
 * what it would remove, and that goes to the trash. Every other git command
 * runs as is; a folder git cleans is untracked work, so it is the user's.
 */
async function git(args: readonly string[]): Promise<number> {
  let index = 0;
  let cwd = process.cwd();
  while (index < args.length && args[index]!.startsWith("-")) {
    const arg = args[index]!;
    if (arg === "-C") cwd = path.resolve(cwd, args[index + 1] ?? ".");
    index += GIT_VALUE_OPTIONS.has(arg) && !arg.includes("=") ? 2 : 1;
  }
  if (args[index] !== "clean") return runReal("git", args);
  const global = args.slice(0, index);
  const rest = args.slice(index + 1);
  let force = false;
  let quiet = false;
  const dry: string[] = [];
  for (let at = 0; at < rest.length; at++) {
    const arg = rest[at]!;
    if (arg === "--") {
      dry.push(...rest.slice(at));
      break;
    }
    if (
      ["-n", "--dry-run", "-i", "--interactive", "-h", "--help"].includes(arg)
    )
      return runReal("git", args);
    if (arg === "--force") {
      force = true;
      dry.push(arg);
    } else if (arg === "--quiet") quiet = true;
    else if (/^-[a-zA-Z]+$/.test(arg)) {
      if (/[ni]/.test(arg)) return runReal("git", args);
      if (arg.includes("f")) force = true;
      if (arg.includes("q")) quiet = true;
      const kept = arg.replace(/q/g, "");
      // `-e` takes the next argument.
      if (kept.length > 1) dry.push(kept);
      if (arg.endsWith("e")) dry.push(rest[++at] ?? "");
    } else dry.push(arg);
  }
  // Without force, git refuses (or, configured not to, deletes): leave it to git.
  if (!force) return runReal("git", args);
  const real = realTool("git");
  if (real == null) return runReal("git", args);
  const listing = spawnSync(
    real,
    [...global, "-c", "core.quotePath=false", "clean", "-n", ...dry],
    { encoding: "utf8", windowsHide: true }
  );
  if (listing.error != null || listing.status !== 0)
    return runReal("git", args);
  const targets = listing.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Would remove "))
    .map((line) => {
      const shown = line.slice("Would remove ".length);
      return { shown, abs: path.resolve(cwd, shown) };
    });

  return await dispose("git clean", targets, removeTree, (target) => {
    if (!quiet) process.stdout.write(`Removing ${target.shown}\n`);
  });
}

/** cmd's `del`/`erase`: files only; a folder means the files in it; `/s` reaches every subfolder. */
async function cmdDel(args: readonly string[]): Promise<number> {
  const recurse = args.some((arg) => /^\/s$/i.test(arg));
  const names = args.filter((arg) => !arg.startsWith("/"));
  const files: Target[] = [];
  const pattern = (glob: string): RegExp =>
    new RegExp(
      `^${glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
      "i"
    );
  const walk = (dir: string, match: RegExp | null): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recurse) walk(full, match);
      } else if (match == null || match.test(entry.name))
        files.push({ shown: full, abs: full });
    }
  };
  let status = 0;
  for (const name of names) {
    const abs = path.resolve(name);
    const base = path.basename(abs);
    const before = files.length;
    if (/[*?]/.test(base)) walk(path.dirname(abs), pattern(base));
    else if (lstat(abs)?.isDirectory() === true) walk(abs, null);
    else if (recurse) walk(path.dirname(abs), pattern(base));
    else if (lstat(abs) != null) files.push({ shown: name, abs });
    if (files.length === before) {
      process.stderr.write(`Could Not Find ${abs}\n`);
      status = 1;
    }
  }

  return Math.max(status, await dispose("del", files, removeTree));
}

/** cmd's `rd`/`rmdir`: an empty folder, or with `/s` the whole tree. */
async function cmdRd(args: readonly string[]): Promise<number> {
  const recurse = args.some((arg) => /^\/s$/i.test(arg));
  let status = 0;
  const targets: Target[] = [];
  for (const name of args.filter((arg) => !arg.startsWith("/"))) {
    const target = resolveTarget(name);
    const info = lstat(target.abs);
    if (info?.isDirectory() !== true) {
      process.stderr.write(
        info == null
          ? "The system cannot find the file specified.\n"
          : "The directory name is invalid.\n"
      );
      status = 2;
    } else if (!recurse && !isEmptyDir(target.abs)) {
      process.stderr.write("The directory is not empty.\n");
      status = 145;
    } else targets.push(target);
  }

  return Math.max(status, await dispose("rd", targets, removeTree));
}

/** A quoted-span mask: the same length, with every quoted character an `x`. */
function maskQuotes(text: string, quote: string): string {
  let inside = false;
  let out = "";
  for (const char of text) {
    if (char === quote) {
      inside = !inside;
      out += char;
    } else out += inside ? "x" : char;
  }
  return out;
}

const quoteArg = (arg: string): string => `"${arg.replace(/"/g, '""')}"`;

/** Where cmd starts a command: after a separator, `(`, `do`, `else`, or `if [not] exist x`. */
const CMD_DELETE_VERB =
  /(^|[&|(]|\bdo\s|\belse\s|\bexist\s+\S+\s)(\s*@?)(del|erase|rd|rmdir)(?=$|[\s/,;=])/gi;

/** cmd's own deletes in a command line, pointed back at this file. Unchanged when there are none. */
export function rewriteCmdDeletes(
  line: string,
  node: string,
  entry: string
): string {
  const masked = maskQuotes(line, '"');
  let out = "";
  let last = 0;
  for (const match of masked.matchAll(CMD_DELETE_VERB)) {
    const verbAt = match.index + match[1]!.length + match[2]!.length;
    const verb = match[3]!.toLowerCase();
    const command = verb === "del" || verb === "erase" ? "cmd-del" : "cmd-rd";
    // Backslashes: cmd reads a forward slash as a switch.
    const flags = entry.endsWith(".ts") ? " --no-warnings" : "";
    out += `${line.slice(last, verbAt)}${quoteArg(node.replace(/\//g, "\\"))}${flags} ${quoteArg(entry.replace(/\//g, "\\"))} ${command}`;
    last = verbAt + match[3]!.length;
  }

  return out + line.slice(last);
}

/** `cmd /c …` with its `del` and `rd` sent to the trash; anything else runs as written. */
async function cmd(args: readonly string[]): Promise<number> {
  const at = args.findIndex((arg) => /^\/[ck]$/i.test(arg));
  const node = process.env[TRASH_ENV.node];
  const entry = process.env[TRASH_ENV.entry];
  if (at < 0 || node == null || entry == null) return runReal("cmd", args);
  const rest = args.slice(at + 1);
  // One argument is the command line itself; several are its words.
  const line =
    rest.length === 1
      ? rest[0]!
      : rest
          .map((arg) => (/[\s&|<>^]/.test(arg) ? quoteArg(arg) : arg))
          .join(" ");
  const rewritten = rewriteCmdDeletes(line, node, entry);
  if (rewritten === line) return runReal("cmd", args);
  const switches = args.slice(0, at).join(" ");

  return runReal(
    "cmd",
    [`${switches} /d /s ${args[at]} "${rewritten}"`.trim()],
    { windowsVerbatimArguments: true }
  );
}

/**
 * PowerShell's deletes through this file: a global `Remove-Item` (which its
 * `rm`, `del`, `erase`, `rd`, `rmdir` and `ri` aliases resolve to) that sends
 * file-system items here and leaves every other provider to the real cmdlet,
 * and a `Clear-RecycleBin` that only says why it will not. Inline, not a
 * script file, so no execution policy stands in the way.
 */
export function powershellPrelude(message: string): string {
  const quoted = message.replace(/'/g, "''");

  return [
    `function global:Clear-RecycleBin { throw '${quoted}' };`,
    "function global:Remove-Item {",
    "[CmdletBinding(DefaultParameterSetName='Path', SupportsShouldProcess=$true)]",
    "param(",
    "[Parameter(ParameterSetName='Path', Mandatory=$true, Position=0, ValueFromPipeline=$true, ValueFromPipelineByPropertyName=$true)][string[]]$Path,",
    "[Parameter(ParameterSetName='LiteralPath', Mandatory=$true, ValueFromPipelineByPropertyName=$true)][Alias('PSPath','LP')][string[]]$LiteralPath,",
    "[string]$Filter, [string[]]$Include, [string[]]$Exclude, [switch]$Recurse, [switch]$Force, [pscredential]$Credential, [string[]]$Stream",
    ")",
    "begin { $abtItems = New-Object System.Collections.Generic.List[string] }",
    "process {",
    "if ($Stream -or $Credential -or $WhatIfPreference) { Microsoft.PowerShell.Management\\Remove-Item @PSBoundParameters; return };",
    "$abtGet = @{ Force = [bool]$Force };",
    "if ($PSCmdlet.ParameterSetName -eq 'LiteralPath') { $abtGet.LiteralPath = $LiteralPath } else { $abtGet.Path = $Path };",
    "if ($Filter) { $abtGet.Filter = $Filter }; if ($Include) { $abtGet.Include = $Include }; if ($Exclude) { $abtGet.Exclude = $Exclude };",
    "foreach ($abtItem in @(Get-Item @abtGet)) {",
    "if ($abtItem.PSProvider.Name -ne 'FileSystem') { Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $abtItem.PSPath -Recurse:$Recurse -Force:$Force; continue };",
    "if ($abtItem.PSIsContainer -and -not $Recurse -and @(Get-ChildItem -LiteralPath $abtItem.FullName -Force).Count -gt 0) { Write-Error ('Cannot remove ' + $abtItem.FullName + ': it is not empty and -Recurse was not given.'); continue };",
    "$abtItems.Add($abtItem.FullName)",
    "}",
    "}",
    `end { if ($abtItems.Count -gt 0) { & $env:${TRASH_ENV.node} $env:${TRASH_ENV.entry} ps-trash @abtItems } }`,
    "};",
  ].join(" ");
}

/** powershell.exe and pwsh options that take a value. */
const PS_VALUE_OPTIONS = [
  "psconsolefile",
  "version",
  "inputformat",
  "outputformat",
  "windowstyle",
  "configurationname",
  "configurationfile",
  "custompipename",
  "executionpolicy",
  "settingsfile",
  "workingdirectory",
  "encodedarguments",
];

/** Which option an abbreviation names, PowerShell's way: a unique prefix (with its documented short forms). */
function psOption(arg: string): string | null {
  if (!/^[-/]/.test(arg)) return null;
  const name = arg.slice(1).split(":")[0]!.toLowerCase();
  const shortForms: Record<string, string> = {
    c: "command",
    f: "file",
    e: "encodedcommand",
    ec: "encodedcommand",
    enc: "encodedcommand",
    cwa: "commandwithargs",
    ex: "executionpolicy",
    ep: "executionpolicy",
    wd: "workingdirectory",
  };
  if (shortForms[name] != null) return shortForms[name]!;
  const all = [
    "command",
    "commandwithargs",
    "file",
    "encodedcommand",
    "nologo",
    "noexit",
    "noprofile",
    "noninteractive",
    "sta",
    "mta",
    "interactive",
    "login",
    "help",
    ...PS_VALUE_OPTIONS,
  ];
  const hits = all.filter((option) => option.startsWith(name));

  return hits.includes(name) ? name : hits.length === 1 ? hits[0]! : name;
}

/** A PowerShell literal for one argument of a script run with `-File`. */
const psArg = (arg: string): string =>
  /^-[A-Za-z_][\w-]*:?$/.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`;

/** A command line's room, less a margin for the runtime path PowerShell is started with. */
const MAX_COMMAND = 30_000;

/**
 * `powershell`/`pwsh` with the prelude ahead of what it runs: `-Command`, a
 * `-File` script, `-EncodedCommand`. Anything else (an interactive shell, a
 * command on stdin) runs as written.
 */
export function rewritePowershell(
  args: readonly string[],
  prelude: string,
  cwd: string,
  pwsh: boolean
): string[] | null {
  let at = 0;
  while (at < args.length) {
    const option = psOption(args[at]!);
    if (option == null) break;
    if (option === "command" || option === "file") break;
    if (option === "encodedcommand") break;
    if (option === "commandwithargs") return null;
    at += PS_VALUE_OPTIONS.includes(option) && !args[at]!.includes(":") ? 2 : 1;
  }
  if (at >= args.length) return null;
  const before = args.slice(0, at);
  const option = psOption(args[at]!);
  let script: string;
  if (option === "encodedcommand") {
    const encoded = args[at + 1];
    if (encoded == null) return null;
    script = Buffer.from(encoded, "base64").toString("utf16le");
  } else if (option === "command" || (option == null && !pwsh)) {
    const words = args.slice(option == null ? at : at + 1);
    if (words.length === 0 || words[0] === "-") return null;
    script = words.join(" ");
  } else {
    const words = args.slice(option == null ? at : at + 1);
    const file = words[0];
    if (file == null) return null;
    script = `& '${path.resolve(cwd, file).replace(/'/g, "''")}' ${words.slice(1).map(psArg).join(" ")}; exit $LASTEXITCODE`;
  }
  const command = `${prelude} ${script}`;
  if (command.length > MAX_COMMAND) return null;

  return [...before, "-Command", command];
}

async function powershell(
  name: "powershell" | "pwsh",
  args: readonly string[]
): Promise<number> {
  const rewritten = rewritePowershell(
    args,
    powershellPrelude(emptyTrashMessage()),
    process.cwd(),
    name === "pwsh"
  );

  return runReal(name, rewritten ?? args);
}

/** PowerShell's `Remove-Item` hands its file-system items here, whole. */
async function psTrash(args: readonly string[]): Promise<number> {
  return await dispose(
    "Remove-Item",
    args.map((arg) => ({ shown: arg, abs: path.resolve(arg) })),
    removeTree
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "rm":
      return await rm(args);
    case "rmdir":
      return await rmdir(args);
    case "unlink":
      return await unlink(args);
    case "find":
      return await find(args);
    case "git":
      return await git(args);
    case "cmd":
      return await cmd(args);
    case "cmd-del":
      return await cmdDel(args);
    case "cmd-rd":
      return await cmdRd(args);
    case "powershell":
    case "pwsh":
      return await powershell(command, args);
    case "ps-trash":
      return await psTrash(args);
    default:
      process.stderr.write(`trash-shim: unknown command ${String(command)}\n`);
      return 2;
  }
}

// Run only as the launchers' target, never when the agent imports this file.
if (/^trash-shim\.(?:[cm]?js|ts)$/.test(path.basename(process.argv[1] ?? ""))) {
  main(process.argv.slice(2)).then(
    (status) => process.exit(status),
    (error: unknown) => {
      process.stderr.write(`trash-shim: ${String(error)}\n`);
      process.exit(1);
    }
  );
}
