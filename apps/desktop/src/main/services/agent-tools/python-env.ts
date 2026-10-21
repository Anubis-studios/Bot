/**
 * The Python environments the app uses: private virtualenvs under the app's
 * own directory, never the system or user site-packages, so removing the app
 * removes everything it installed. The components run in one only the app
 * writes to; the agent's shell gets its own, which its commands may
 * `pip install` into and which nothing in this process runs.
 *
 * Their interpreter is the system Python when one meets the floor, otherwise
 * a pinned build that uv installs under the app's directory. uv itself is
 * fetched on first need from its pinned release and checked against the
 * digests below. Nothing runs at startup: most sessions never need Python.
 */
import { execFile } from "child_process";
import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";

import { childProcessEnv } from "@abacus-ai/agent/child-env";
import extract from "extract-zip";

import { abacusBotHome } from "../../paths";
import { agentProxyEnv } from "../../system-network";

const execFileAsync = promisify(execFile);

/** The uv release used to install Python and packages. */
const UV_VERSION = "0.12.24";

/** Release asset and its published sha256, per `${platform}-${arch}`. */
const UV_BUILDS: Record<string, { asset: string; sha256: string }> = {
  "darwin-arm64": {
    asset: "uv-aarch64-apple-darwin.tar.gz",
    sha256: "0c4346de7abdb49495b393b9ec809fe387aa43e586be20fecb972216c1e71732",
  },
  "darwin-x64": {
    asset: "uv-x86_64-apple-darwin.tar.gz",
    sha256: "4fa82e37cb94767661f532b001e470b67a186c7260e305bd84ddb78fd545c0b6",
  },
  "linux-arm64": {
    asset: "uv-aarch64-unknown-linux-musl.tar.gz",
    sha256: "7f9ab4726d743b6a92e310477a7840c8a8a7b3938cb3c4657d541342fca75011",
  },
  "linux-x64": {
    asset: "uv-x86_64-unknown-linux-musl.tar.gz",
    sha256: "48170bd200a5430298c18f3b264485a1f3a8605f01088277daf6e37633edf0f5",
  },
  "win32-arm64": {
    asset: "uv-aarch64-pc-windows-msvc.zip",
    sha256: "4b783bda5cc44bbae0651a837223873a7acee31152381aef5fc86ef6bef25997",
  },
  "win32-x64": {
    asset: "uv-x86_64-pc-windows-msvc.zip",
    sha256: "7c38608c8a18ee137d748a1773053b07ec8f3a30fab49aebaa6f4e4efeceb019",
  },
};

/** Installed when the machine has no usable Python; uv verifies the download. */
export const MANAGED_PYTHON_VERSION = "3.13.16";

/** The oldest system Python used as is; anything older gets the managed one. */
const PYTHON_FLOOR: readonly [number, number] = [3, 10];

/** Import name → the pinned requirement that provides it. */
const REQUIREMENTS: Record<string, string> = {
  pypdf: "pypdf==6.20.1",
  pdfplumber: "pdfplumber==0.11.10",
  reportlab: "reportlab==5.0.1",
};

const PROBE_TIMEOUT_MS = 5_000;
const SETUP_TIMEOUT_MS = 600_000;

const isWindows = process.platform === "win32";

/**
 * A virtualenv: where it lives, and whether it is the shell's (pip in it, and
 * writable by sandboxed commands, so this process never runs anything from it).
 */
type Env = { dir: () => string; shell: boolean };

/** The components' packages. No sandboxed command can write here. */
const APP_ENV: Env = {
  dir: () => path.join(abacusBotHome(), "python"),
  shell: false,
};
/** The agent shell's, on its PATH when the machine has no usable Python. */
const SHELL_ENV: Env = {
  dir: () => path.join(abacusBotHome(), "shell-python"),
  shell: true,
};

/** uv, its cache and the Python builds it installs. */
const runtimeDir = (): string => path.join(abacusBotHome(), "python-runtime");

const binDir = (env: Env): string =>
  path.join(env.dir(), isWindows ? "Scripts" : "bin");

const pythonIn = (env: Env): string =>
  path.join(binDir(env), isWindows ? "python.exe" : "python");

const exists = async (target: string): Promise<boolean> =>
  await fs
    .stat(target)
    .then(() => true)
    .catch(() => false);

/** The file PATH resolves `name` to, or null. */
const onPath = async (name: string): Promise<string | null> => {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir.length > 0 && (await exists(path.join(dir, name))))
      return path.join(dir, name);
  }
  return null;
};

/**
 * Without the Command Line Tools, macOS's /usr/bin/python3 is a stub that
 * opens an install dialog when run, so it is not probed.
 */
const isMacStub = async (candidate: string): Promise<boolean> => {
  if (process.platform !== "darwin") return false;
  if ((await onPath(candidate)) !== `/usr/bin/${candidate}`) return false;
  return await execFileAsync("xcode-select", ["-p"], {
    timeout: PROBE_TIMEOUT_MS,
  }).then(
    () => false,
    () => true
  );
};

/** The interpreter at `file` if it runs and meets the floor, as an absolute path. */
const usablePython = async (file: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync(
      file,
      ["-c", "import sys; print(*sys.version_info[:2], sys.executable)"],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true }
    );
    const [major, minor, ...rest] = stdout.trim().split(" ");
    const version = [Number(major), Number(minor)];
    const meets =
      version[0] > PYTHON_FLOOR[0] ||
      (version[0] === PYTHON_FLOOR[0] && version[1] >= PYTHON_FLOOR[1]);
    return meets && rest.length > 0 ? rest.join(" ") : null;
  } catch {
    // Missing, a Store alias, or broken.
    return null;
  }
};

let systemProbe: Promise<string | null> | undefined;

/** The first system Python that meets the floor, once per process. */
const systemPython = (): Promise<string | null> =>
  (systemProbe ??= (async () => {
    for (const candidate of ["python3", "python"]) {
      if (await isMacStub(candidate)) continue;
      const found = await usablePython(candidate);
      if (found != null) return found;
    }
    return null;
  })());

/**
 * The shell's environment when it, not the system Python, is what `python`
 * and `pip` should run in the agent's shell; null otherwise.
 */
export const managedPythonEnv = async (): Promise<{
  envDir: string;
  binDir: string;
} | null> =>
  (await systemPython()) == null
    ? { envDir: SHELL_ENV.dir(), binDir: binDir(SHELL_ENV) }
    : null;

/** uv's environment: app-owned locations only, and the system proxy and certificates. */
const uvEnv = async (): Promise<Record<string, string>> =>
  childProcessEnv(process.env, await agentProxyEnv("https://github.com"), {
    UV_NO_CONFIG: "1",
    UV_CACHE_DIR: path.join(runtimeDir(), "cache"),
    UV_PYTHON_INSTALL_DIR: path.join(runtimeDir(), "pythons"),
    UV_SYSTEM_CERTS: "1",
    UV_NO_PROGRESS: "1",
    // An activated environment in the app's own environment must not redirect uv.
    VIRTUAL_ENV: undefined,
    UV_PYTHON: undefined,
  });

const runUv = async (uv: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync(uv, args, {
    env: await uvEnv(),
    timeout: SETUP_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
};

const uvBinary = (): string =>
  path.join(runtimeDir(), "uv", UV_VERSION, isWindows ? "uv.exe" : "uv");

/** The pinned uv, downloaded and verified on first need. */
const ensureUv = async (): Promise<string> => {
  const target = uvBinary();
  if (await exists(target)) return target;

  const build = UV_BUILDS[`${process.platform}-${process.arch}`];
  if (build == null)
    throw new Error(
      `Python cannot be set up on ${process.platform}-${process.arch}.`
    );
  const response = await fetch(
    `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${build.asset}`
  );
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(body).digest("hex") !== build.sha256)
    throw new Error(`${build.asset} did not match its checksum`);

  // Unpacked beside the target and renamed in, so a half-written uv never
  // passes the check above.
  await fs.mkdir(runtimeDir(), { recursive: true });
  const scratch = await fs.mkdtemp(path.join(runtimeDir(), "uv-"));
  try {
    const archive = path.join(scratch, build.asset);
    await fs.writeFile(archive, body);
    if (build.asset.endsWith(".zip")) await extract(archive, { dir: scratch });
    else await execFileAsync("tar", ["xzf", archive, "-C", scratch]);
    const unpacked = build.asset.endsWith(".zip")
      ? path.join(scratch, "uv.exe")
      : path.join(scratch, build.asset.replace(/\.tar\.gz$/, ""), "uv");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(unpacked, target);
    if (!isWindows) await fs.chmod(target, 0o755);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  return target;
};

let managedBase: string | undefined;

/** The managed interpreter, installed if needed (uv resumes or skips). */
const managedPython = async (uv: string): Promise<string> => {
  if (managedBase != null) return managedBase;
  await runUv(uv, [
    "python",
    "install",
    MANAGED_PYTHON_VERSION,
    // Nothing on the user's own PATH or in the Windows registry.
    "--no-bin",
    "--no-registry",
  ]);
  const found = await runUv(uv, [
    "python",
    "find",
    "--managed-python",
    "--no-project",
    MANAGED_PYTHON_VERSION,
  ]);
  managedBase = found.trim();
  return managedBase;
};

/** Environments checked in this process. */
const ready = new Set<string>();

/** Whether the environment is usable; the shell's is judged from its files alone. */
const healthy = async (env: Env): Promise<boolean> => {
  if (!(await exists(pythonIn(env)))) return false;
  if (!env.shell) return (await usablePython(pythonIn(env))) != null;
  // Read, never run: the base it was made from must still be there.
  const config = await fs
    .readFile(path.join(env.dir(), "pyvenv.cfg"), "utf8")
    .catch(() => "");
  const home = /^home\s*=\s*(.+)$/m.exec(config)?.[1]?.trim();
  return home != null && (await exists(home));
};

/** The environment, created on a usable base when missing or broken. */
const ensureEnv = async (
  env: Env,
  uv: () => Promise<string>
): Promise<void> => {
  if (ready.has(env.dir())) return;
  if (!(await healthy(env))) {
    const tool = await uv();
    const base = (await systemPython()) ?? (await managedPython(tool));
    // --clear replaces a broken one.
    await runUv(tool, [
      "venv",
      "--clear",
      ...(env.shell ? ["--seed"] : []),
      "--python",
      base,
      env.dir(),
    ]);
  }
  ready.add(env.dir());
};

/** What a failed step tells the user: the cause they can act on. */
const setupError = (what: string, error: unknown): Error => {
  const detail = [
    (error as Error)?.message ?? String(error),
    (error as { stderr?: string })?.stderr ?? "",
  ].join("\n");
  console.warn(`[python-env] ${what}:`, detail);
  if (/ENOSPC|No space left|disk (is )?full|quota/i.test(detail))
    return new Error(
      `${what}: the disk is full. Free some space and try again.`
    );
  if (
    /fetch failed|ERR_(INTERNET|NAME|PROXY|CONNECTION|TIMED|ADDRESS|NETWORK)|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|dns|connect|timed out|error sending request|proxy|\b407\b/i.test(
      detail
    )
  )
    return new Error(
      `${what}: the download did not get through. Check the internet connection (or the proxy) and try again.`
    );
  return new Error(`${what}: ${detail.trim().slice(0, 200)}`);
};

export type PythonEnv = {
  /** Absolute path to the interpreter to run things with. */
  python: string;
  /** Packages installed during this call, for reporting back to the user. */
  installed: string[];
};

let ensureChain: Promise<unknown> = Promise.resolve();

/** Serialized, so concurrent callers share one setup and one install. */
const serialized = <T>(run: () => Promise<T>): Promise<T> => {
  const result = ensureChain.then(run, run);
  ensureChain = result.catch(() => undefined);

  return result;
};

/** The components' interpreter with `imports` available, installing what is missing. */
export const ensurePython = (imports: string[]): Promise<PythonEnv> =>
  serialized(() => ensurePythonNow(imports));

/** The agent shell's environment, set up if it is not there yet. */
export const ensureShellPython = (): Promise<void> =>
  serialized(async () => {
    let uv: string | undefined;
    try {
      await ensureEnv(SHELL_ENV, async () => (uv ??= await ensureUv()));
    } catch (error) {
      throw setupError("Could not set up Python", error);
    }
  });

const ensurePythonNow = async (imports: string[]): Promise<PythonEnv> => {
  let uv: string | undefined;
  const getUv = async (): Promise<string> => (uv ??= await ensureUv());

  try {
    await ensureEnv(APP_ENV, getUv);
  } catch (error) {
    throw setupError("Could not set up Python", error);
  }

  const missing: string[] = [];
  for (const name of imports) {
    try {
      await execFileAsync(pythonIn(APP_ENV), ["-c", `import ${name}`], {
        timeout: 30_000,
        windowsHide: true,
      });
    } catch {
      missing.push(REQUIREMENTS[name] ?? name);
    }
  }

  if (missing.length > 0) {
    try {
      await runUv(await getUv(), [
        "pip",
        "install",
        "--python",
        pythonIn(APP_ENV),
        ...missing,
      ]);
    } catch (error) {
      throw setupError(`Could not install ${missing.join(", ")}`, error);
    }
  }

  return { python: pythonIn(APP_ENV), installed: missing };
};
