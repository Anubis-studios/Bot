/**
 * A Discord lane that is not signed in stops loading discord.com by itself.
 *
 * The hidden page reloaded every 30s while it found neither the app nor a
 * login form, with no limit: a page that can never load (a network that
 * blocks discord.com, a challenge page) reloaded all night, and again on every
 * launch. Now a few reloads, then the lane waits on the user; a page that
 * fails to load at all waits at once; and a lane that was signed out last time
 * loads nothing until the user opens Discord.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

/** A stand-in for each Discord window built: loads, listeners, lifetime. */
class FakeWindow {
  static built: FakeWindow[] = [];
  loads: string[] = [];
  destroyed = false;
  visible = false;
  readonly events = new Map<string, Listener>();
  readonly contentsEvents = new Map<string, Listener>();
  readonly webContents = {
    on: (name: string, fn: Listener) => this.contentsEvents.set(name, fn),
    off: () => {},
    setUserAgent: () => {},
    setAudioMuted: () => {},
  };
  constructor() {
    FakeWindow.built.push(this);
  }
  loadURL = async (url: string) => {
    this.loads.push(url);
  };
  on(name: string, fn: Listener) {
    this.events.set(name, fn);
  }
  off() {}
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.events.get("closed")?.();
  }
  isVisible() {
    return this.visible;
  }
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  removeMenu() {}
  /** Fire a webContents event the way Electron does. */
  emit(name: string, ...args: unknown[]) {
    this.contentsEvents.get(name)?.({ preventDefault: () => {} }, ...args);
  }
}

vi.mock("electron", () => ({
  BrowserWindow: FakeWindow,
  session: { fromPartition: () => ({}) },
  shell: { openExternal: async () => undefined },
}));
vi.mock("../../bring-to-front", () => ({
  parentWindow: () => undefined,
  bringToFront: () => {},
  dismissOnEscape: () => {},
  presentAsDialog: (win: { show: () => void }) => win.show(),
}));

/** The stored sign-in verdict, and every write to it. */
const record = { signedIn: null as boolean | null, writes: [] as boolean[] };
vi.mock("./messaging-config-service", () => ({
  readPlatformSignedIn: () => record.signedIn,
  savePlatformSignedIn: (_id: string, signedIn: boolean) => {
    record.signedIn = signedIn;
    record.writes.push(signedIn);
  },
}));

const { DiscordWebConnector } = await import("./discord-web-connector");

const SPINNER = { loggedIn: false, loginVisible: false };
const LOGIN_FORM = { loggedIn: false, loginVisible: true };
const SIGNED_IN = { loggedIn: true, loginVisible: false };

/** Polls the page sits on the spinner before one reload (STUCK_BOOT_POLLS). */
const POLLS_PER_RELOAD = 20;

type Internals = {
  run: (script: string) => Promise<unknown>;
  ensureWindow: () => FakeWindow | null;
  checkLogin: () => Promise<void>;
  refreshContacts: () => Promise<void>;
  crawlGuilds: () => Promise<void>;
  startInboundPolling: () => void;
};

const connectorOn = (page: { state: unknown }) => {
  const states: Array<[string, string | undefined]> = [];
  const connector = new DiscordWebConnector({
    onMessage: () => {},
    onState: (state: string, message?: string) => states.push([state, message]),
    onLog: () => {},
  } as never);
  const internals = connector as unknown as Internals;
  // The real run builds the window on demand; the page's answer is the test's.
  internals.run = async () =>
    internals.ensureWindow() == null ? null : page.state;
  // Work that follows a sign-in is not what is under test.
  internals.refreshContacts = async () => {};
  internals.crawlGuilds = async () => {};
  internals.startInboundPolling = () => {};
  const poll = async (times: number) => {
    for (let i = 0; i < times; i += 1) await internals.checkLogin();
  };
  const loads = () => FakeWindow.built.flatMap((win) => win.loads).length;
  const last = () => states.at(-1);
  return { connector, states, poll, loads, last };
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeWindow.built = [];
  record.signedIn = null;
  record.writes = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a page stuck short of sign-in", () => {
  it("is reloaded three times, then the lane waits on the user", async () => {
    const page = { state: SPINNER as unknown };
    const { connector, poll, loads, last } = connectorOn(page);
    await connector.start();
    expect(loads()).toBe(1);

    await poll(POLLS_PER_RELOAD * 3);
    expect(loads()).toBe(4);

    await poll(POLLS_PER_RELOAD);
    expect(last()).toEqual([
      "needs_login",
      expect.stringContaining("Open Discord"),
    ]);
    expect(FakeWindow.built[0].destroyed).toBe(true);

    // Parked: neither the poll nor a probe brings the page back.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await poll(POLLS_PER_RELOAD * 5);
    expect(await connector.probeLive()).toBe(false);
    expect(FakeWindow.built).toHaveLength(1);
    expect(loads()).toBe(4);
    await connector.stop();
  });

  it("starts over when the user opens Discord", async () => {
    const page = { state: SPINNER as unknown };
    const { connector, poll, loads, last } = connectorOn(page);
    await connector.start();
    await poll(POLLS_PER_RELOAD * 4);
    expect(last()?.[0]).toBe("needs_login");

    connector.showLoginWindow();
    expect(last()).toEqual(["connecting", undefined]);
    expect(FakeWindow.built).toHaveLength(2);
    expect(FakeWindow.built[1].visible).toBe(true);
    expect(loads()).toBe(5);

    // A fresh allowance of reloads, not one left over from before.
    await poll(POLLS_PER_RELOAD * 3);
    expect(loads()).toBe(8);
    expect(last()?.[0]).toBe("connecting");

    page.state = SIGNED_IN;
    await poll(1);
    expect(last()).toEqual(["connected", undefined]);
    await connector.stop();
  });

  it("gets its reloads back after a sign-in", async () => {
    const page = { state: SPINNER as unknown };
    const { connector, poll, loads } = connectorOn(page);
    await connector.start();
    await poll(POLLS_PER_RELOAD * 2);
    expect(loads()).toBe(3);

    page.state = SIGNED_IN;
    await poll(1);
    expect(record.writes).toEqual([true]);

    // Signed out from elsewhere, then the spinner again: three more reloads.
    page.state = SPINNER;
    await poll(2);
    await poll(POLLS_PER_RELOAD * 3);
    expect(loads()).toBe(6);
    await connector.stop();
  });
});

describe("a page that cannot load", () => {
  it("on a certificate failure, is not retried", async () => {
    const { connector, poll, loads, last } = connectorOn({ state: SPINNER });
    await connector.start();
    const win = FakeWindow.built[0];
    win.emit("did-fail-load", -202, "ERR_CERT_AUTHORITY_INVALID", "", true);

    expect(last()).toEqual(["error", expect.stringContaining("blocked")]);
    expect(win.destroyed).toBe(true);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await poll(POLLS_PER_RELOAD * 5);
    expect(loads()).toBe(1);
    await connector.stop();
  });

  it("on a network failure, is not retried", async () => {
    const { connector, last } = connectorOn({ state: SPINNER });
    await connector.start();
    FakeWindow.built[0].emit(
      "did-fail-load",
      -106,
      "ERR_INTERNET_DISCONNECTED",
      "",
      true
    );
    expect(last()).toEqual([
      "error",
      expect.stringContaining("could not be reached"),
    ]);
    await connector.stop();
  });

  it("on Discord's own certificate error, is not retried", async () => {
    const { connector, last } = connectorOn({ state: SPINNER });
    await connector.start();
    FakeWindow.built[0].emit(
      "certificate-error",
      "https://discord.com/channels/@me",
      "net::ERR_CERT_AUTHORITY_INVALID"
    );
    expect(last()?.[0]).toBe("error");
    await connector.stop();
  });

  it("but an aborted navigation or a sub-frame is no failure", async () => {
    const { connector, last } = connectorOn({ state: SPINNER });
    await connector.start();
    const win = FakeWindow.built[0];
    win.emit("did-fail-load", -3, "ERR_ABORTED", "", true);
    win.emit("did-fail-load", -106, "ERR_INTERNET_DISCONNECTED", "", false);
    expect(last()?.[0]).toBe("connecting");
    expect(win.destroyed).toBe(false);
    await connector.stop();
  });

  it("is tried again when the user opens Discord", async () => {
    const page = { state: SPINNER as unknown };
    const { connector, poll, last } = connectorOn(page);
    await connector.start();
    FakeWindow.built[0].emit("did-fail-load", -202, "", "", true);
    expect(last()?.[0]).toBe("error");

    connector.showLoginWindow();
    expect(last()?.[0]).toBe("connecting");
    page.state = LOGIN_FORM;
    await poll(1);
    expect(last()?.[0]).toBe("needs_login");
    await connector.stop();
  });

  it("leaves a signed-in session to its own handling", async () => {
    const { connector, poll, last } = connectorOn({ state: SIGNED_IN });
    await connector.start();
    await poll(1);
    FakeWindow.built[0].emit("did-fail-load", -106, "", "", true);
    expect(last()?.[0]).toBe("connected");
    expect(FakeWindow.built[0].destroyed).toBe(false);
    await connector.stop();
  });
});

describe("at launch", () => {
  it("a lane signed out last time loads nothing until the user opens it", async () => {
    record.signedIn = false;
    const { connector, poll, last } = connectorOn({ state: LOGIN_FORM });
    await connector.start();
    expect(last()).toEqual(["needs_login", expect.any(String)]);
    expect(FakeWindow.built).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await poll(5);
    expect(await connector.probeLive()).toBe(false);
    expect(FakeWindow.built).toHaveLength(0);

    connector.showLoginWindow();
    expect(FakeWindow.built).toHaveLength(1);
    expect(FakeWindow.built[0].visible).toBe(true);
    await connector.stop();
  });

  it("a lane signed in last time, or never recorded, loads as before", async () => {
    for (const signedIn of [true, null]) {
      FakeWindow.built = [];
      record.signedIn = signedIn;
      const { connector, poll, last } = connectorOn({ state: SIGNED_IN });
      await connector.start();
      expect(FakeWindow.built).toHaveLength(1);
      await poll(1);
      expect(last()).toEqual(["connected", undefined]);
      await connector.stop();
    }
  });

  it("a login form is recorded as signed out once, not on every poll", async () => {
    const { connector, poll } = connectorOn({ state: LOGIN_FORM });
    await connector.start();
    await poll(10);
    expect(record.writes).toEqual([false]);
    await connector.stop();
  });
});
