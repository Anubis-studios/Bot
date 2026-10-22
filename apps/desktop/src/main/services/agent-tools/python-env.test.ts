/**
 * The agent shell's Python on a machine without one: when it applies, the
 * pinned build uv installs, one setup shared by concurrent callers, a pinned
 * uv that must match its checksum, failures that name what to fix, and an
 * environment this process never runs (sandboxed commands can write to it).
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("child_process", () => ({ execFile: mocks.execFile }));
vi.mock("../../paths", () => ({ abacusBotHome: (): string => home }));
vi.mock("../../system-network", () => ({
  agentProxyEnv: async (): Promise<Record<string, string>> => ({}),
}));

let home: string;

const isWindows = process.platform === "win32";
const envDir = (): string => path.join(home, "shell-python");
const envBin = (): string => path.join(envDir(), isWindows ? "Scripts" : "bin");
const uvPath = (): string =>
  path.join(
    home,
    "python-runtime",
    "uv",
    "0.12.24",
    isWindows ? "uv.exe" : "uv"
  );
const MANAGED = "/managed/cpython-3.13.16/bin/python3";

type Machine = {
  /** `${major} ${minor}` of the system Python, or null for none. */
  system: string | null;
  /** A uv step fails with this message. */
  uvError?: { step: string; message: string };
};

/** Every uv invocation, as its arguments. */
let uvRuns: string[][];

/** An environment on disk whose pyvenv.cfg names `base`. */
const writeEnv = (base: string): void => {
  fs.mkdirSync(envBin(), { recursive: true });
  fs.writeFileSync(
    path.join(envBin(), isWindows ? "python.exe" : "python"),
    ""
  );
  fs.writeFileSync(path.join(envDir(), "pyvenv.cfg"), `home = ${base}\n`);
};

const machine = (spec: Machine): void => {
  uvRuns = [];
  mocks.execFile.mockImplementation(
    (
      file: string,
      args: string[],
      _opts: unknown,
      callback: (error: Error | null, out?: unknown) => void
    ) => {
      const ok = (stdout = ""): void => callback(null, { stdout, stderr: "" });
      const fail = (message: string): void => callback(new Error(message));

      if (file === uvPath()) {
        uvRuns.push(args);
        const step = args.slice(0, 2).join(" ");
        if (spec.uvError != null && step.startsWith(spec.uvError.step))
          return fail(spec.uvError.message);
        if (args[0] === "venv") {
          writeEnv(home);
          return ok();
        }
        if (step === "python find") return ok(`${MANAGED}\n`);
        return ok();
      }

      if (args[0] === "-c") {
        if (spec.system == null) return fail(`spawn ${file} ENOENT`);
        return ok(`${spec.system} /usr/bin/${file}\n`);
      }

      if (file === "xcode-select") return ok("/Library/Developer\n");

      return fail(`unexpected command: ${file} ${args.join(" ")}`);
    }
  );
};

/** A uv already downloaded, so a test that is not about the download skips it. */
const haveUv = (): void => {
  fs.mkdirSync(path.dirname(uvPath()), { recursive: true });
  fs.writeFileSync(uvPath(), "");
};

const load = async (): Promise<typeof import("./python-env")> =>
  await import("./python-env");

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "python-env-"));
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  mocks.execFile.mockReset();
  vi.unstubAllGlobals();
});

describe("when the shell gets the app's own Python", () => {
  it("not when the system has one that meets the floor", async () => {
    machine({ system: "3 12" });
    const { managedPythonEnv } = await load();

    expect(await managedPythonEnv()).toBeNull();
  });

  it.each([
    ["no Python at all", null],
    ["a Python below the floor", "3 8"],
  ])("with %s, installing the pinned build", async (_label, system) => {
    machine({ system });
    haveUv();
    const { ensureShellPython, managedPythonEnv, MANAGED_PYTHON_VERSION } =
      await load();

    expect(await managedPythonEnv()).toEqual({
      envDir: envDir(),
      binDir: envBin(),
    });
    await ensureShellPython();

    expect(uvRuns).toEqual([
      [
        "python",
        "install",
        MANAGED_PYTHON_VERSION,
        "--no-bin",
        "--no-registry",
      ],
      [
        "python",
        "find",
        "--managed-python",
        "--no-project",
        MANAGED_PYTHON_VERSION,
      ],
      ["venv", "--clear", "--seed", "--python", MANAGED, envDir()],
    ]);
  });
});

describe("the environment", () => {
  it("is never run by this process, only read", async () => {
    machine({ system: null });
    writeEnv(home);
    const { ensureShellPython } = await load();

    await ensureShellPython();

    const ran = mocks.execFile.mock.calls.map(([file]) => String(file));
    expect(ran.some((file) => file.startsWith(envDir()))).toBe(false);
    expect(uvRuns).toEqual([]);
  });

  it("is made again when the interpreter it was made from is gone", async () => {
    machine({ system: null });
    haveUv();
    writeEnv(path.join(home, "gone"));
    const { ensureShellPython } = await load();

    await ensureShellPython();

    expect(uvRuns.at(-1)?.slice(0, 3)).toEqual(["venv", "--clear", "--seed"]);
  });

  it("is set up once for concurrent callers", async () => {
    machine({ system: null });
    haveUv();
    const { ensureShellPython } = await load();

    await Promise.all([
      ensureShellPython(),
      ensureShellPython(),
      ensureShellPython(),
    ]);

    expect(uvRuns.filter((args) => args[0] === "venv")).toHaveLength(1);
    expect(
      uvRuns.filter((args) => args.slice(0, 2).join(" ") === "python install")
    ).toHaveLength(1);
  });
});

describe("uv itself", () => {
  it("refuses a download that does not match the pinned checksum", async () => {
    machine({ system: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
    );
    const { ensureShellPython } = await load();

    await expect(ensureShellPython()).rejects.toThrow(/checksum/);
    expect(fs.existsSync(uvPath())).toBe(false);
  });
});

describe("failures", () => {
  it("says the download did not get through when offline, and the next caller retries", async () => {
    machine({ system: null });
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("net::ERR_INTERNET_DISCONNECTED"),
      });
    });
    vi.stubGlobal("fetch", fetch);
    const { ensureShellPython } = await load();

    await expect(ensureShellPython()).rejects.toThrow(
      /^Could not set up Python: the download did not get through/
    );
    await expect(ensureShellPython()).rejects.toThrow(/did not get through/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("says the disk is full", async () => {
    machine({
      system: null,
      uvError: {
        step: "python install",
        message: "failed to write file: No space left on device (os error 28)",
      },
    });
    haveUv();
    const { ensureShellPython } = await load();

    await expect(ensureShellPython()).rejects.toThrow(/the disk is full/);
  });

  it("says the download did not get through when uv's own request fails", async () => {
    machine({
      system: null,
      uvError: {
        step: "python install",
        message:
          "Failed to install cpython\n  cause: error sending request for url\n  cause: tcp connect error",
      },
    });
    haveUv();
    const { ensureShellPython } = await load();

    await expect(ensureShellPython()).rejects.toThrow(/did not get through/);
  });
});
