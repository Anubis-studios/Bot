/**
 * R5-T27/T28 (main side), spec 05 §31.5 h: every failure path sets both
 * `error` and `failedPhase`, read from the state before the failure cleared
 * it; a new check clears both.
 */
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const autoUpdater = new EventEmitter() as EventEmitter &
  Record<string, unknown>;

vi.mock("electron-updater", () => ({
  default: { autoUpdater },
}));
const electronApp = vi.hoisted(() => ({
  relaunch: vi.fn(),
  quit: vi.fn(),
  exit: vi.fn(),
}));
// A .deb install, with or without pkexec; off unless a test turns it on.
const deb = vi.hoisted(() => ({
  isDeb: false,
  pkexec: null as string | null,
  install: vi.fn(
    async (): Promise<{ ok: true } | { ok: false; detail: string }> => ({
      ok: true,
    })
  ),
}));
vi.mock("./deb-install", () => ({
  isDebPackage: () => deb.isDeb,
  graphicalElevation: () => deb.pkexec,
  installDebWithPkexec: deb.install,
  manualInstallCommand: (path: string) => `sudo apt install ${path}`,
}));
vi.mock("electron", () => ({
  app: {
    getVersion: () => "1.0.18",
    isPackaged: false,
    on: () => {},
    relaunch: electronApp.relaunch,
    quit: electronApp.quit,
    exit: electronApp.exit,
  },
  BaseWindow: { getAllWindows: () => [] },
  powerMonitor: { on: () => {}, getSystemIdleTime: () => 0 },
}));
vi.mock("../../app-quit-state", () => ({
  markQuitting: () => {},
  clearQuitting: () => {},
}));
vi.mock("./relaunch-hidden", () => ({
  markRelaunchHidden: () => {},
  clearRelaunchHidden: () => {},
}));
vi.mock("#main/renderer-host", () => ({ sendToRenderer: () => {} }));
vi.mock("#main/rpc/emit", () => ({ emitBusChannel: () => {} }));

const { UpdateService, failedPhaseOf } = await import("./update-service");

beforeEach(() => {
  deb.isDeb = false;
  deb.pkexec = null;
  deb.install.mockReset().mockResolvedValue({ ok: true });
  electronApp.relaunch.mockClear();
  electronApp.quit.mockClear();
  electronApp.exit.mockClear();
  autoUpdater.removeAllListeners();
  autoUpdater.setFeedURL = () => {};
  autoUpdater.checkForUpdates = async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: "1.0.19" },
  });
  autoUpdater.quitAndInstall = () => {};
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
});

const downloaded = (): InstanceType<typeof UpdateService> => {
  const service = new UpdateService();
  autoUpdater.emit("update-available", { version: "1.0.19" });
  autoUpdater.emit("update-downloaded", { version: "1.0.19" });
  return service;
};

describe("UpdateStatus.failedPhase", () => {
  it("starts null", () => {
    expect(new UpdateService().getStatus()).toMatchObject({
      error: null,
      failedPhase: null,
    });
  });

  it("an updater error while checking is a check failure", () => {
    const service = new UpdateService();
    autoUpdater.emit("checking-for-update");
    autoUpdater.emit("error", new Error("feed unreachable\nheaders…"));
    expect(service.getStatus()).toMatchObject({
      checking: false,
      error: "feed unreachable",
      failedPhase: "check",
    });
  });

  it("an updater error mid-download is a download failure", () => {
    const service = new UpdateService();
    autoUpdater.emit("update-available", { version: "1.0.19" });
    autoUpdater.emit("download-progress", {
      percent: 10,
      bytesPerSecond: 1,
      total: 10,
      transferred: 1,
    });
    autoUpdater.emit("error", new Error("net::ERR_NETWORK_CHANGED"));
    expect(service.getStatus()).toMatchObject({
      downloading: false,
      progress: null,
      error: "net::ERR_NETWORK_CHANGED",
      failedPhase: "download",
    });
  });

  it("an updater error after the install hand-off is an install failure", async () => {
    vi.useFakeTimers();
    try {
      const service = downloaded();
      await service.installUpdate();
      autoUpdater.emit("error", new Error("signature mismatch"));
      expect(service.getStatus()).toMatchObject({
        error: "signature mismatch",
        failedPhase: "install",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkForUpdates's own failure is a check failure", async () => {
    autoUpdater.checkForUpdates = async () => {
      throw new Error("ENOTFOUND downloads.abacus.ai");
    };
    const service = new UpdateService();
    await expect(service.checkForUpdates()).resolves.toEqual({
      success: false,
      error: "ENOTFOUND downloads.abacus.ai",
    });
    expect(service.getStatus()).toMatchObject({
      error: "ENOTFOUND downloads.abacus.ai",
      failedPhase: "check",
    });
  });

  it("installUpdate's failure sets error and install (it used to set neither)", async () => {
    const service = new UpdateService();
    await expect(service.installUpdate()).resolves.toEqual({
      success: false,
      error: "No update downloaded to install",
    });
    expect(service.getStatus()).toMatchObject({
      installing: false,
      error: "No update downloaded to install",
      failedPhase: "install",
    });

    autoUpdater.quitAndInstall = () => {
      throw new Error("Squirrel refused");
    };
    const ready = downloaded();
    await ready.installUpdate();
    expect(ready.getStatus()).toMatchObject({
      installing: false,
      error: "Squirrel refused",
      failedPhase: "install",
    });
  });

  it("a new check clears both", async () => {
    const service = new UpdateService();
    autoUpdater.emit("error", new Error("boom"));
    expect(service.getStatus().failedPhase).toBe("check");
    await service.checkForUpdates();
    expect(service.getStatus()).toMatchObject({
      error: null,
      failedPhase: null,
    });

    autoUpdater.emit("error", new Error("boom"));
    autoUpdater.emit("checking-for-update");
    expect(service.getStatus()).toMatchObject({
      error: null,
      failedPhase: null,
    });
  });

  it("failedPhaseOf reads the pre-error state", () => {
    expect(failedPhaseOf({ installing: true, downloading: false })).toBe(
      "install"
    );
    expect(failedPhaseOf({ installing: false, downloading: true })).toBe(
      "download"
    );
    expect(failedPhaseOf({ installing: false, downloading: false })).toBe(
      "check"
    );
  });
});

/**
 * Linux .deb. electron-updater installs it with `sudo dpkg -i`, which has no
 * password prompt in a GUI app, so every attempt failed, the quit watchdog
 * force-quit the app and the next idle restart tried again, forever.
 */
describe("a .deb update", () => {
  const PACKAGE = "/home/u/.cache/abacusai-bot-updater/pending/bot.deb";
  const debDownloaded = (version = "1.0.19") => {
    const service = new UpdateService();
    autoUpdater.emit("update-available", { version });
    autoUpdater.emit("update-downloaded", {
      version,
      downloadedFile: PACKAGE,
    });
    return service;
  };
  beforeEach(() => {
    deb.isDeb = true;
    autoUpdater.quitAndInstall = vi.fn();
  });

  it("without a graphical password prompt is a manual install from the start", async () => {
    const service = debDownloaded();
    expect(service.getStatus()).toMatchObject({
      downloaded: true,
      error: null,
      failedPhase: null,
      manualInstall: {
        command: `sudo apt install ${PACKAGE}`,
        packagePath: PACKAGE,
      },
    });

    // Nothing to try: no sudo, no quit.
    const result = await service.installUpdate();
    expect(result.success).toBe(false);
    expect(deb.install).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(electronApp.quit).not.toHaveBeenCalled();
    expect(service.getStatus().installing).toBe(false);
  });

  it("with pkexec, a click installs through it and relaunches", async () => {
    deb.pkexec = "/usr/bin/pkexec";
    const service = debDownloaded();
    expect(service.getStatus().manualInstall).toBeNull();

    await expect(service.installUpdate()).resolves.toEqual({
      success: true,
    });
    expect(deb.install).toHaveBeenCalledWith("/usr/bin/pkexec", PACKAGE);
    // electron-updater's sudo path is never taken.
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(electronApp.relaunch).toHaveBeenCalledTimes(1);
    expect(electronApp.quit).toHaveBeenCalledTimes(1);
  });

  it("a failed pkexec install marks the version failed and never retries or force-quits", async () => {
    vi.useFakeTimers();
    try {
      deb.pkexec = "/usr/bin/pkexec";
      deb.install.mockResolvedValue({ ok: false, detail: "exit 126" });
      const service = debDownloaded();

      const result = await service.installUpdate();
      expect(result.success).toBe(false);
      expect(service.getStatus()).toMatchObject({
        installing: false,
        installStalled: false,
        manualInstall: {
          command: `sudo apt install ${PACKAGE}`,
          packagePath: PACKAGE,
        },
      });

      // No watchdog: the app stays up.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(electronApp.quit).not.toHaveBeenCalled();
      expect(electronApp.exit).not.toHaveBeenCalled();
      expect(service.getStatus().installStalled).toBe(false);

      // Another click, the quit path and a re-offer of the same version do
      // not try it again.
      await service.installUpdate();
      await service.installUpdate({ silent: true });
      autoUpdater.emit("update-available", { version: "1.0.19" });
      await service.installUpdate();
      expect(deb.install).toHaveBeenCalledTimes(1);
      expect(service.getStatus().manualInstall).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a newer release after a failed one installs again from a click", async () => {
    deb.pkexec = "/usr/bin/pkexec";
    deb.install.mockResolvedValueOnce({ ok: false, detail: "exit 127" });
    const service = debDownloaded("1.0.19");
    await service.installUpdate();
    expect(service.getStatus().manualInstall).not.toBeNull();

    autoUpdater.checkForUpdates = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: "1.0.20" },
    });
    autoUpdater.emit("update-available", { version: "1.0.20" });
    expect(service.getStatus().manualInstall).toBeNull();
    autoUpdater.emit("update-downloaded", {
      version: "1.0.20",
      downloadedFile: PACKAGE,
    });
    expect(service.getStatus().manualInstall).toBeNull();
    await expect(service.installUpdate()).resolves.toEqual({
      success: true,
    });
    expect(deb.install).toHaveBeenCalledTimes(2);
  });

  it("an automatic install (quit, idle) is refused without touching the state", async () => {
    deb.pkexec = "/usr/bin/pkexec";
    const service = debDownloaded();
    const before = service.getStatus();

    const result = await service.installUpdate({ silent: true });
    expect(result.success).toBe(false);
    expect(deb.install).not.toHaveBeenCalled();
    expect(electronApp.quit).not.toHaveBeenCalled();
    expect(service.getStatus()).toEqual(before);
  });
});
