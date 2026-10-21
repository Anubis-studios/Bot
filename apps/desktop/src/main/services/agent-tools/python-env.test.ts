/**
 * Which interpreter the app's Python environment is built on, and how its
 * setup behaves: the system Python when it meets the floor, otherwise the
 * pinned build uv installs; one setup shared by concurrent callers; a pinned
 * uv that must match its checksum; and failures that name what to fix.
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
const envBin = (name = "python"): string =>
  path.join(home, name, isWindows ? "Scripts" : "bin");
const envPython = (name = "python"): string =>
  path.join(envBin(name), isWindows ? "python.exe" : "python");
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
  /** Imports the environment already has. */
  present?: string[];
  /** A uv step fails with this message. */
  uvError?: { step: string; message: string };
};

/** Every uv invocation, as its arguments. */
let uvRuns: string[][];

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
          const name = path.basename(args.at(-1) ?? "");
          fs.mkdirSync(envBin(name), { recursive: true });
          fs.writeFileSync(envPython(name), "");
          return ok();
        }
        if (step === "python find") return ok(`${MANAGED}\n`);
        return ok();
      }

      if (args[0] === "-c" && args[1]?.startsWith("import sys")) {
        // The environment's own interpreter is the managed or system one.
        if (file.startsWith(home)) return ok(`3 13 ${file}\n`);
        if (spec.system == null) return fail(`spawn ${file} ENOENT`);
        return ok(`${spec.system} /usr/bin/${file}\n`);
      }

      if (args[0] === "-c") {
        const name = (args[1] ?? "").replace(/^import\s+/, "");
        return spec.present?.includes(name) === true
          ? ok()
          : fail(`No module named ${name}`);
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

describe("the interpreter the environment is built on", () => {
  it("uses a system Python that meets the floor and installs pinned packages", async () => {
    machine({ system: "3 12" });
    haveUv();
    const { ensurePython, managedPythonEnv } = await load();

    const result = await ensurePython(["pypdf"]);

    expect(uvRuns[0]).toEqual([
      "venv",
      "--clear",
      "--python",
      "/usr/bin/python3",
      path.join(home, "python"),
    ]);
    expect(uvRuns.some((args) => args[0] === "python")).toBe(false);
    expect(uvRuns.at(-1)).toEqual([
      "pip",
      "install",
      "--python",
      envPython(),
      "pypdf==6.20.1",
    ]);
    expect(result).toEqual({
      python: envPython(),
      installed: ["pypdf==6.20.1"],
    });
    expect(await managedPythonEnv()).toBeNull();
  });

  it.each([
    ["no Python at all", null],
    ["a Python below the floor", "3 8"],
  ])("installs the pinned build with %s", async (_label, system) => {
    machine({ system });
    haveUv();
    const {
      ensurePython,
      ensureShellPython,
      managedPythonEnv,
      MANAGED_PYTHON_VERSION,
    } = await load();

    await ensurePython([]);
    await ensureShellPython();

    expect(uvRuns[0]).toEqual([
      "python",
      "install",
      MANAGED_PYTHON_VERSION,
      "--no-bin",
      "--no-registry",
    ]);
    expect(uvRuns[2]).toEqual([
      "venv",
      "--clear",
      "--python",
      MANAGED,
      path.join(home, "python"),
    ]);
    // The shell's own environment, with pip for its commands, on the same base.
    expect(uvRuns.at(-1)).toEqual([
      "venv",
      "--clear",
      "--seed",
      "--python",
      MANAGED,
      path.join(home, "shell-python"),
    ]);
    // Not the components' environment: a sandboxed pip may write to this one.
    expect(await managedPythonEnv()).toEqual({
      envDir: path.join(home, "shell-python"),
      binDir: envBin("shell-python"),
    });
  });

  it("keeps a working environment and needs no uv for what it already has", async () => {
    machine({ system: null, present: ["pypdf"] });
    fs.mkdirSync(envBin(), { recursive: true });
    fs.writeFileSync(envPython(), "");
    const { ensurePython } = await load();

    expect(await ensurePython(["pypdf"])).toEqual({
      python: envPython(),
      installed: [],
    });
    expect(uvRuns).toEqual([]);
  });
});

describe("the shell's environment", () => {
  /** A shell environment on disk whose pyvenv.cfg names `base`. */
  const shellEnv = (base: string): void => {
    fs.mkdirSync(envBin("shell-python"), { recursive: true });
    fs.writeFileSync(envPython("shell-python"), "");
    fs.writeFileSync(
      path.join(home, "shell-python", "pyvenv.cfg"),
      `home = ${base}\nversion_info = 3.13.16\n`
    );
  };

  it("is never run by this process: sandboxed commands can write to it", async () => {
    machine({ system: null });
    shellEnv(home);
    const { ensureShellPython } = await load();

    await ensureShellPython();

    const ran = mocks.execFile.mock.calls.map(([file]) => String(file));
    expect(ran.some((file) => file.includes("shell-python"))).toBe(false);
    expect(uvRuns).toEqual([]);
  });

  it("is made again when the interpreter it was made from is gone", async () => {
    machine({ system: null });
    haveUv();
    shellEnv(path.join(home, "gone"));
    const { ensureShellPython } = await load();

    await ensureShellPython();

    expect(uvRuns.at(-1)?.slice(0, 3)).toEqual(["venv", "--clear", "--seed"]);
  });
});

describe("concurrent callers", () => {
  it("share one setup", async () => {
    machine({ system: null });
    haveUv();
    const { ensurePython, ensureShellPython } = await load();

    await Promise.all([
      ensurePython([]),
      ensureShellPython(),
      ensurePython([]),
      ensureShellPython(),
    ]);

    // One per environment, on one install of the interpreter.
    expect(uvRuns.filter((args) => args[0] === "venv")).toHaveLength(2);
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
    const { ensurePython } = await load();

    await expect(ensurePython([])).rejects.toThrow(/checksum/);
    expect(fs.existsSync(uvPath())).toBe(false);
  });
});

describe("failures", () => {
  it("says the download did not get through when offline", async () => {
    machine({ system: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", {
          cause: new Error("net::ERR_INTERNET_DISCONNECTED"),
        });
      })
    );
    const { ensurePython } = await load();

    await expect(ensurePython([])).rejects.toThrow(
      /^Could not set up Python: the download did not get through/
    );
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
    const { ensurePython } = await load();

    await expect(ensurePython([])).rejects.toThrow(/the disk is full/);
  });

  it("names the packages a failed install was for, and a retry runs again", async () => {
    machine({
      system: "3 12",
      uvError: {
        step: "pip install",
        message: "error sending request for url (https://pypi.org/simple/)",
      },
    });
    haveUv();
    const { ensurePython } = await load();

    await expect(ensurePython(["pdfplumber"])).rejects.toThrow(
      /^Could not install pdfplumber==0\.11\.10: the download did not get through/
    );
    await expect(ensurePython(["pdfplumber"])).rejects.toThrow(/pdfplumber/);
    expect(uvRuns.filter((args) => args[0] === "pip")).toHaveLength(2);
  });
});
