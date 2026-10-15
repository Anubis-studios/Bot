import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { installPosixShell, posixShellEnv } from "./posix-shell-install.js";
import { posixShellOperations, windowsShellPrompt } from "./posix-shell.js";

const payload = fileURLToPath(
  new URL("../vendor/busybox.exe", import.meta.url)
);

it.skipIf(process.platform !== "win32" || !existsSync(payload))(
  "runs the shipped shell directly when its cache cannot be created",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "busybox-fallback-"));
    try {
      const blockedRoot = join(root, "blocked");
      writeFileSync(blockedRoot, "not a directory");
      const shell = installPosixShell({ payload, cacheRoot: blockedRoot });
      expect(shell?.sh).toBe(payload);
      expect(shell?.args).toEqual(["sh"]);
      const output: Buffer[] = [];
      const result = await posixShellOperations(shell)?.exec(
        "printf 'ok'",
        root,
        {
          onData: (chunk) => output.push(chunk),
        }
      );
      expect(result?.exitCode).toBe(0);
      expect(Buffer.concat(output).toString()).toBe("ok");
      expect(
        execFileSync(payload, ["sh", "-c", "printf ok"], { encoding: "utf8" })
      ).toBe("ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

const fakeShell = {
  sh: "C:/bb/bin/sh.exe",
  bin: "C:/bb/bin",
  overrideApplets: ";x",
};

describe("posixShellEnv temp dir", () => {
  it("fills TMPDIR from the Windows temp dir when it is missing", () => {
    const env = posixShellEnv(
      { Path: "C:/Windows", TEMP: "C:/Users/U/Temp", TMP: "C:/Users/U/Tmp" },
      fakeShell
    );
    expect(env.TMPDIR).toBe("C:/Users/U/Temp");
    expect(env.TEMP).toBe("C:/Users/U/Temp");
    expect(env.TMP).toBe("C:/Users/U/Tmp");
  });

  it("never overrides a value that is there, whatever its case", () => {
    const env = posixShellEnv(
      { Path: "C:/Windows", TmpDir: "D:/scratch", Temp: "C:/T" },
      fakeShell
    );
    expect(env.TmpDir).toBe("D:/scratch");
    expect(env.Temp).toBe("C:/T");
    expect(env.TMP).toBe("C:/T");
    expect(
      Object.keys(env).filter((k) => k.toUpperCase() === "TMPDIR")
    ).toEqual(["TmpDir"]);
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "TEMP")).toEqual([
      "Temp",
    ]);
  });

  it("falls back to the OS temp dir when none is set, or the one set is empty", () => {
    expect(posixShellEnv({ Path: "C:/Windows" }, fakeShell)).toMatchObject({
      TMPDIR: tmpdir(),
      TMP: tmpdir(),
      TEMP: tmpdir(),
    });
    expect(posixShellEnv({ TEMP: "" }, fakeShell)).toMatchObject({
      TEMP: "",
      TMP: tmpdir(),
      TMPDIR: tmpdir(),
    });
  });

  it("only applies where the bundled shell exists, which is Windows", () => {
    expect(installPosixShell({ platform: "darwin" })).toBeUndefined();
    expect(installPosixShell({ platform: "linux" })).toBeUndefined();
  });
});

describe("windowsShellPrompt", () => {
  const prompt = windowsShellPrompt(fakeShell) ?? "";

  it("states the shell's facts the model gets wrong", () => {
    for (const fact of [
      "busybox ash",
      "'C:/Users/Name/project'",
      "/mnt/c",
      "'C:/Program Files/...'",
      "no /tmp",
      '"$TMPDIR"',
      "nohup",
      "`background`",
      "command -v",
      "%NAME%",
      "powershell -NoProfile -Command '",
      "-File",
    ])
      expect(prompt).toContain(fact);
  });

  it("stays short: it is in every Windows turn's system prompt", () => {
    expect(prompt.length).toBeLessThan(1_800);
    expect(prompt.split("\n").every((line) => line.length <= 100)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "is absent on macOS and Linux",
    () => {
      expect(windowsShellPrompt()).toBeNull();
      expect(windowsShellPrompt(undefined)).toBeNull();
    }
  );
});

it.skipIf(process.platform !== "win32" || !existsSync(payload))(
  "gives the shipped shell a usable $TMPDIR",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "busybox-tmpdir-"));
    try {
      const shell = installPosixShell({
        payload,
        cacheRoot: join(root, "cache"),
      });
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => k.toUpperCase() !== "TMPDIR"
        )
      );
      const output: Buffer[] = [];
      const result = await posixShellOperations(shell)?.exec(
        'cd "$TMPDIR" && f=$(mktemp) && printf ok > "$f" && cat "$f" && rm "$f"',
        root,
        { onData: (chunk) => output.push(chunk), env }
      );
      expect(Buffer.concat(output).toString()).toBe("ok");
      expect(result?.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
