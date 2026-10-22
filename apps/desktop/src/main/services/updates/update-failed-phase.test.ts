/**
 * R5-T27/T28 (main side), spec 05 §31.5 h: every failure path sets both
 * `error` and `failedPhase`, read from the state before the failure cleared
 * it; a new check clears both.
 */
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const autoUpdater = new EventEmitter() as EventEmitter &
  Record<string, unknown>;

// electron-updater picks DebUpdater from resources/package-type.
const deb = vi.hoisted(() => ({ isDeb: false }));
vi.mock("electron-updater", () => ({
  default: {
    autoUpdater,
    DebUpdater: class {
      static [Symbol.hasInstance]() {
        return deb.isDeb;
      }
    },
  },
}));
// electron-store, in memory: what install-record keeps across a relaunch.
const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock("electron-store", () => ({
  default: class {
    get(key: string) {
      return store.get(key);
    }
    set(key: string, value: unknown) {
      store.set(key, value);
    }
    delete(key: string) {
      store.delete(key);
    }
  },
}));
const electronApp = vi.hoisted(() => ({
  relaunch: vi.fn(),
  quit: vi.fn(),
  exit: vi.fn(),
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
const quitState = vi.hoisted(() => ({ quitting: false }));
vi.mock("../../app-quit-state", () => ({
  markQuitting: () => {
    quitState.quitting = true;
  },
  clearQuitting: () => {
    quitState.quitting = false;
  },
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
  store.clear();
  quitState.quitting = false;
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
 * Linux .deb, through electron-updater's own DebUpdater. Its quitAndInstall
 * runs dpkg synchronously behind the prompt its LinuxUpdater picks, and a
 * failure is an `error` event before it returns. That failure used to be
 * followed by the quit watchdog's force-quit and, after the relaunch, the
 * idle restart's retry: a loop.
 */
describe("a .deb update", () => {
  const PACKAGE = "/home/u/.cache/abacusai-bot-updater/pending/bot.deb";
  // What electron-updater's LinuxUpdater would elevate with.
  let sudoCommand = "pkexec";
  let installFails = false;
  const quitAndInstall = vi.fn((_silent?: boolean, _forceRun?: boolean) => {
    if (installFails) {
      autoUpdater.emit(
        "error",
        new Error("Command pkexec exited with code 126")
      );
      return;
    }
    electronApp.relaunch();
    electronApp.quit();
  });
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
    sudoCommand = "pkexec";
    installFails = false;
    quitAndInstall.mockClear();
    autoUpdater.quitAndInstall = quitAndInstall;
    autoUpdater.isRunningAsRoot = () => false;
    autoUpdater.determineSudoCommand = () => sudoCommand;
  });

  it("with no graphical prompt (plain sudo) is a manual install from the start", async () => {
    sudoCommand = "sudo";
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

    // Neither a click nor the quit path attempts it.
    await expect(service.installUpdate()).resolves.toEqual({
      success: false,
      error: "Install this update from a terminal",
    });
    await service.installUpdate({ silent: true });
    expect(quitAndInstall).not.toHaveBeenCalled();
    expect(electronApp.quit).not.toHaveBeenCalled();
    expect(service.getStatus().installing).toBe(false);
  });

  it("running as root needs no prompt and installs", async () => {
    sudoCommand = "sudo";
    autoUpdater.isRunningAsRoot = () => true;
    const service = debDownloaded();
    expect(service.getStatus().manualInstall).toBeNull();
    await expect(service.installUpdate()).resolves.toEqual({ success: true });
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("with a prompt, installs through electron-updater's quitAndInstall", async () => {
    const service = debDownloaded();
    expect(service.getStatus().manualInstall).toBeNull();

    await expect(service.installUpdate()).resolves.toEqual({ success: true });
    expect(quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(electronApp.relaunch).toHaveBeenCalledTimes(1);
    expect(store.get("attemptedVersion")).toBe("1.0.19");
  });

  it("a failed install marks the version failed, never force-quits and never retries", async () => {
    vi.useFakeTimers();
    try {
      installFails = true;
      const service = debDownloaded();

      await expect(service.installUpdate()).resolves.toEqual({
        success: false,
        error: "Install this update from a terminal",
      });
      expect(service.getStatus()).toMatchObject({
        installing: false,
        installStalled: false,
        manualInstall: {
          command: `sudo apt install ${PACKAGE}`,
          packagePath: PACKAGE,
        },
      });
      // The quit intent is dropped: a window close hides again.
      expect(quitState.quitting).toBe(false);
      expect(store.get("failedVersion")).toBe("1.0.19");

      // No watchdog: the app stays up.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(electronApp.quit).not.toHaveBeenCalled();
      expect(electronApp.exit).not.toHaveBeenCalled();
      expect(service.getStatus().installStalled).toBe(false);

      // A click, the quit path and a re-offer of the same version do not try
      // it again.
      await service.installUpdate();
      await service.installUpdate({ silent: true });
      autoUpdater.emit("update-available", { version: "1.0.19" });
      await service.installUpdate();
      expect(quitAndInstall).toHaveBeenCalledTimes(1);
      expect(service.getStatus().manualInstall).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failure from the quit path lets the quit go on", async () => {
    installFails = true;
    const service = debDownloaded();
    await expect(service.installUpdate({ silent: true })).resolves.toEqual({
      success: false,
      error: "Install this update from a terminal",
    });
    expect(quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(service.getStatus().manualInstall).not.toBeNull();
  });

  it("the failure survives a restart, and so does a hand-off that relaunched into the old version", async () => {
    installFails = true;
    await debDownloaded().installUpdate();
    // Relaunched, still 1.0.18: the failed version stays manual.
    expect(debDownloaded().getStatus().manualInstall).not.toBeNull();

    store.clear();
    installFails = false;
    await debDownloaded().installUpdate();
    expect(store.get("attemptedVersion")).toBe("1.0.19");
    // The install "succeeded" but this launch is still 1.0.18.
    const relaunched = debDownloaded();
    expect(relaunched.getStatus().manualInstall).not.toBeNull();
    expect(store.get("failedVersion")).toBe("1.0.19");
    expect(store.get("attemptedVersion")).toBeUndefined();
    // The two hand-offs above; this launch attempts nothing.
    await relaunched.installUpdate({ silent: true });
    expect(quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it("a launch on the failed version or later clears the mark", () => {
    store.set("failedVersion", "1.0.18");
    debDownloaded();
    expect(store.get("failedVersion")).toBeUndefined();
  });

  it("a newer release after a failed one installs again", async () => {
    installFails = true;
    const service = debDownloaded("1.0.19");
    await service.installUpdate();
    expect(service.getStatus().manualInstall).not.toBeNull();

    installFails = false;
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
    await expect(service.installUpdate()).resolves.toEqual({ success: true });
    expect(quitAndInstall).toHaveBeenCalledTimes(2);
  });
});
