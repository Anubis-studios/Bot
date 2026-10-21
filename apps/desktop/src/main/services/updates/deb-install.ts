import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Installing a .deb update needs root. electron-updater's own path runs
 * `sudo dpkg -i` from a GUI process with no terminal, where sudo cannot ask
 * for a password and always fails. So the .deb install is done here: through
 * pkexec's graphical prompt when the session has one, and by the user in a
 * terminal when it does not.
 */

/** electron-builder records the package format in resources/package-type. */
export const isDebPackage = (
  resourcesPath: string | undefined = process.resourcesPath
): boolean => {
  if (process.platform !== "linux" || !resourcesPath) return false;
  try {
    const type = readFileSync(join(resourcesPath, "package-type"), "utf8");
    return type.trim() === "deb";
  } catch {
    // No marker: an AppImage or an unpacked build, not a .deb install.
    return false;
  }
};

/** The first executable `name` on PATH; relative entries are skipped. */
const findOnPath = (name: string, env: NodeJS.ProcessEnv): string | null => {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
};

/**
 * pkexec, when the session can show its password dialog: a display to draw
 * on. Null means no graphical way to become root, so nothing is attempted.
 */
export const graphicalElevation = (
  env: NodeJS.ProcessEnv = process.env
): string | null =>
  env.DISPLAY || env.WAYLAND_DISPLAY ? findOnPath("pkexec", env) : null;

const shellQuote = (value: string): string =>
  /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;

/** What the user runs in a terminal when the app cannot install the .deb. */
export const manualInstallCommand = (packagePath: string): string =>
  `sudo apt install ${shellQuote(packagePath)}`;

export type DebInstallResult = { ok: true } | { ok: false; detail: string };

/**
 * Installs the package as root through pkexec's dialog. Asynchronous, so the
 * app keeps drawing while the dialog is up. Not run through a shell; apt-get
 * resolves any new dependency, dpkg is the fallback where it is missing.
 */
export const installDebWithPkexec = (
  pkexec: string,
  packagePath: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<DebInstallResult> => {
  const aptGet = findOnPath("apt-get", env);
  const command = aptGet
    ? [aptGet, "install", "-y", packagePath]
    : [findOnPath("dpkg", env) ?? "dpkg", "-i", packagePath];
  return new Promise((resolve) => {
    // --disable-internal-agent: with no dialog agent pkexec fails at once
    // rather than waiting on a terminal prompt nobody can see.
    const child = spawn(pkexec, ["--disable-internal-agent", ...command], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.once("error", (error) =>
      resolve({ ok: false, detail: error.message })
    );
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      // 126: the dialog was dismissed; 127: not authorized or no agent.
      const lastLine = stderr.trim().split("\n").at(-1) ?? "";
      resolve({
        ok: false,
        detail: `${signal ? `signal ${signal}` : `exit ${code}`}${lastLine ? `: ${lastLine}` : ""}`,
      });
    });
  });
};
