import { EventEmitter } from "node:events";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const autoUpdater = Object.assign(new EventEmitter(), {
  isRunningAsRoot: () => false,
  determineSudoCommand: () => deb.sudo,
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: "1.0.82" },
  })),
  quitAndInstall: vi.fn(),
});
const markRelaunchHidden = vi.fn();
const windows = vi.hoisted(() => ({ visible: false }));
const deb = vi.hoisted(() => ({ isDeb: false, sudo: "sudo" }));
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
  deb.sudo = "sudo";
  store.clear();
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

const idleDeb = async (sudo: string) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  windows.visible = true;
  deb.isDeb = true;
  deb.sudo = sudo;
  const service = new UpdateService({ isSafeToRestart: () => true });
  autoUpdater.emit("update-downloaded", {
    version: "1.0.82",
    downloadedFile: "/tmp/bot.deb",
  });
  await vi.advanceTimersByTimeAsync(60_000);
  return service;
};

it("an idle .deb with a graphical prompt restarts through electron-updater", async () => {
  const service = await idleDeb("pkexec");
  expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  expect(service.getStatus().installing).toBe(true);
});

it("an idle .deb with only sudo never restarts by itself: it is a manual install", async () => {
  const service = await idleDeb("sudo");
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  expect(service.getStatus()).toMatchObject({
    downloaded: true,
    installing: false,
    manualInstall: { packagePath: "/tmp/bot.deb" },
  });
});

it("an idle .deb whose install failed is not retried by the idle restart", async () => {
  autoUpdater.quitAndInstall.mockImplementationOnce(() => {
    autoUpdater.emit("error", new Error("Command pkexec exited with code 127"));
  });
  const service = await idleDeb("pkexec");
  expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  expect(service.getStatus()).toMatchObject({
    installing: false,
    installStalled: false,
    manualInstall: { packagePath: "/tmp/bot.deb" },
  });
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  expect(service.getStatus().installStalled).toBe(false);
});
