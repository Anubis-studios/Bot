import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  graphicalElevation,
  installDebWithPkexec,
  isDebPackage,
  manualInstallCommand,
} from "./deb-install";

const dir = () => mkdtempSync(join(tmpdir(), "deb-install-"));
const executable = (folder: string, name: string, body: string) => {
  const file = join(folder, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};

// pkexec and apt-get stand-ins are shell scripts.
const posix = describe.skipIf(process.platform === "win32");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isDebPackage", () => {
  it("reads electron-builder's package-type marker on Linux only", () => {
    const resources = dir();
    writeFileSync(join(resources, "package-type"), "deb\n");
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(isDebPackage(resources)).toBe(true);

    writeFileSync(join(resources, "package-type"), "rpm");
    expect(isDebPackage(resources)).toBe(false);
    // An AppImage has no marker.
    expect(isDebPackage(dir())).toBe(false);
    expect(isDebPackage(undefined)).toBe(false);

    writeFileSync(join(resources, "package-type"), "deb");
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(isDebPackage(resources)).toBe(false);
  });
});

posix("graphicalElevation", () => {
  it("is pkexec when there is a display to show its prompt on", () => {
    const bin = dir();
    const pkexec = executable(bin, "pkexec", "exit 0");
    expect(graphicalElevation({ PATH: bin, DISPLAY: ":0" })).toBe(pkexec);
    expect(
      graphicalElevation({ PATH: bin, WAYLAND_DISPLAY: "wayland-0" })
    ).toBe(pkexec);
  });

  it("is null without a display or without pkexec, so nothing is attempted", () => {
    const bin = dir();
    executable(bin, "pkexec", "exit 0");
    expect(graphicalElevation({ PATH: bin })).toBeNull();
    expect(graphicalElevation({ PATH: dir(), DISPLAY: ":0" })).toBeNull();
    // A relative PATH entry is not searched.
    expect(
      graphicalElevation({ PATH: "relative/bin", DISPLAY: ":0" })
    ).toBeNull();
  });
});

describe("manualInstallCommand", () => {
  it("names the downloaded package, quoted when the path needs it", () => {
    expect(manualInstallCommand("/home/u/.cache/x/bot_1.0.90_amd64.deb")).toBe(
      "sudo apt install /home/u/.cache/x/bot_1.0.90_amd64.deb"
    );
    expect(manualInstallCommand("/home/o'neil/My Bot.deb")).toBe(
      `sudo apt install '/home/o'\\''neil/My Bot.deb'`
    );
  });
});

posix("installDebWithPkexec", () => {
  it("runs apt-get on the package through pkexec, with no terminal agent", async () => {
    const bin = dir();
    const argsFile = join(bin, "args");
    const pkexec = executable(
      bin,
      "pkexec",
      `printf '%s\\n' "$@" > ${argsFile}`
    );
    const aptGet = executable(bin, "apt-get", "exit 0");

    await expect(
      installDebWithPkexec(pkexec, "/tmp/My Bot.deb", { PATH: bin })
    ).resolves.toEqual({ ok: true });
    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "--disable-internal-agent",
      aptGet,
      "install",
      "-y",
      "/tmp/My Bot.deb",
    ]);
  });

  it("falls back to dpkg -i where apt-get is missing", async () => {
    const bin = dir();
    const argsFile = join(bin, "args");
    const pkexec = executable(
      bin,
      "pkexec",
      `printf '%s\\n' "$@" > ${argsFile}`
    );
    const dpkg = executable(bin, "dpkg", "exit 0");

    await installDebWithPkexec(pkexec, "/tmp/bot.deb", { PATH: bin });
    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "--disable-internal-agent",
      dpkg,
      "-i",
      "/tmp/bot.deb",
    ]);
  });

  it("reports a dismissed prompt or a failed install as a failure", async () => {
    const bin = dir();
    const dismissed = executable(
      bin,
      "pkexec",
      "echo 'Error executing command as another user: Request dismissed' >&2; exit 126"
    );
    await expect(
      installDebWithPkexec(dismissed, "/tmp/bot.deb", { PATH: bin })
    ).resolves.toEqual({
      ok: false,
      detail:
        "exit 126: Error executing command as another user: Request dismissed",
    });
    await expect(
      installDebWithPkexec(join(bin, "missing"), "/tmp/bot.deb", { PATH: bin })
    ).resolves.toMatchObject({ ok: false });
  });
});
