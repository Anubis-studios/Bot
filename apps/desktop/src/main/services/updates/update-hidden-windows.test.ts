import { EventEmitter } from "node:events";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const autoUpdater = Object.assign(new EventEmitter(), {
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: "1.0.82" },
  })),
  quitAndInstall: vi.fn(),
});
const markRelaunchHidden = vi.fn();
const windows = vi.hoisted(() => ({ visible: false }));
const deb = vi.hoisted(() => ({
  isDeb: false,
  pkexec: null as string | null,
  install: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("./deb-install", () => ({
  isDebPackage: () => deb.isDeb,
  graphicalElevation: () => deb.pkexec,
  installDebWithPkexec: deb.install,
  manualInstallCommand: (path: string) => `sudo apt install ${path}`,
}));

vi.mock("electron-updater", () => ({ default: { autoUpdater } }));
vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.81", isPackaged: false },
  BaseWindow: {
    getAllWindows: () =>
      windows.visible
        ? [{ isDestroyed: () => false, isVisible: () => true }]
        : [],
  },
  powerMonitor: { getSystemIdleTime: () => 601 },
}));
vi.mock("../../app-quit-state", () => ({
  markQuitting: vi.fn(),
  clearQuitting: vi.fn(),
}));
vi.mock("./relaunch-hidden", () => ({
  markRelaunchHidden,
  clearRelaunchHidden: vi.fn(),
}));

const { UpdateService } = await import("./update-service");

beforeEach(() => {
  vi.useFakeTimers();
  autoUpdater.removeAllListeners();
  autoUpdater.quitAndInstall.mockClear();
  markRelaunchHidden.mockClear();
  windows.visible = false;
  deb.isDeb = false;
  deb.pkexec = null;
  deb.install.mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("installs a downloaded update from a hidden Windows window", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const service = new UpdateService({ isSafeToRestart: () => true });
  autoUpdater.emit("update-downloaded", { version: "1.0.82" });

  await vi.advanceTimersByTimeAsync(60_000);

  expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  expect(markRelaunchHidden).not.toHaveBeenCalled();
  expect(service.getStatus().installing).toBe(true);
});

it("an idle Linux AppImage still restarts into its update", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  windows.visible = true;
  const service = new UpdateService({ isSafeToRestart: () => true });
  autoUpdater.emit("update-downloaded", { version: "1.0.82" });

  await vi.advanceTimersByTimeAsync(60_000);

  expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  expect(service.getStatus().installing).toBe(true);
});

it("a hidden macOS window still restarts hidden", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  new UpdateService({ isSafeToRestart: () => true });
  autoUpdater.emit("update-downloaded", { version: "1.0.82" });

  await vi.advanceTimersByTimeAsync(60_000);

  expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  expect(markRelaunchHidden).toHaveBeenCalledTimes(1);
});

it.each([
  ["without a graphical password prompt", null],
  ["with pkexec", "/usr/bin/pkexec"],
])(
  "an idle .deb %s never restarts by itself: the password prompt needs a click",
  async (_, pkexec) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    windows.visible = true;
    deb.isDeb = true;
    deb.pkexec = pkexec;
    const service = new UpdateService({ isSafeToRestart: () => true });
    autoUpdater.emit("update-downloaded", {
      version: "1.0.82",
      downloadedFile: "/tmp/bot.deb",
    });

    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(deb.install).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({
      downloaded: true,
      installing: false,
      manualInstall: pkexec == null ? { packagePath: "/tmp/bot.deb" } : null,
    });
  }
);
