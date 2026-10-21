import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;
/** What `local-code.json` held when the store was opened. */
let seen: string | null = null;
/** The writes the store made, and how many more of them fail. */
let writes: unknown[] = [];
let failingWrites = 0;

vi.mock("electron", () => ({ app: { getPath: () => home } }));
// electron-store with `clearInvalidConfig` reads an unparsable file as empty
// and overwrites it on the next write; the test only needs when it opens.
vi.mock("electron-store", () => ({
  default: class {
    constructor(options: { name?: string; cwd?: string }) {
      if (options.name === "local-code")
        seen = fs.readFileSync(path.join(home, "local-code.json"), "utf8");
    }
    get() {
      return undefined;
    }
    set(value: unknown) {
      if (failingWrites > 0) {
        failingWrites -= 1;
        throw Object.assign(new Error("EMFILE: too many open files"), {
          code: "EMFILE",
        });
      }
      writes.push(value);
    }
    delete() {}
  },
}));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-store-"));
  process.env.ABACUSAI_BOT_HOME = home;
  seen = null;
  writes = [];
  failingWrites = 0;
  vi.resetModules();
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const file = () => path.join(home, "local-code.json");
const corrupt = () =>
  fs
    .readdirSync(home)
    .filter((name) => name.startsWith("local-code.json.corrupt-"));
const read = (name: string) => fs.readFileSync(path.join(home, name), "utf8");

const full = `${JSON.stringify(
  {
    localCode: {
      workspaces: [
        { id: "w1", path: "/p" },
        { id: "w2", path: "/q" },
      ],
      activeWorkspaceId: "w1",
      agentSessions: [
        { id: "s1", workspaceId: "w1", meta: { title: "one" } },
        { id: "s2", workspaceId: "w2", meta: { title: "two" } },
      ],
    },
    migrated_from_default_v1: true,
  },
  undefined,
  "\t"
)}\n`;
const torn = full.slice(0, full.indexOf('"two"'));

it("puts back the last copy that parsed, keeping the torn bytes beside it", async () => {
  fs.writeFileSync(`${file()}.bak`, full);
  fs.writeFileSync(file(), torn);

  await import("./workspace-store");
  expect(seen).toBe(full);
  expect(read("local-code.json.bak")).toBe(full);
  expect(corrupt().map(read)).toEqual([torn]);
});

it("without a copy, keeps every whole record of a torn file", async () => {
  fs.writeFileSync(file(), torn);

  await import("./workspace-store");
  expect(JSON.parse(seen!)).toEqual({
    localCode: {
      workspaces: [
        { id: "w1", path: "/p" },
        { id: "w2", path: "/q" },
      ],
      activeWorkspaceId: "w1",
      agentSessions: [{ id: "s1", workspaceId: "w1", meta: { title: "one" } }],
    },
  });
  expect(corrupt().map(read)).toEqual([torn]);
});

it("leaves a file with nothing whole in it, and says so", async () => {
  fs.writeFileSync(file(), '{"local');
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  await import("./workspace-store");
  expect(error).toHaveBeenCalledOnce();
  error.mockRestore();
  expect(seen).toBe('{"local');
  expect(corrupt().map(read)).toEqual(['{"local']);
});

it("refreshes the copy from a file that parses, and copies nothing aside", async () => {
  fs.writeFileSync(`${file()}.bak`, "{}");
  fs.writeFileSync(file(), full);

  await import("./workspace-store");
  expect(seen).toBe(full);
  expect(read("local-code.json.bak")).toBe(full);
  expect(corrupt()).toEqual([]);
});

it("changes nothing more on the launch after a restore", async () => {
  fs.writeFileSync(`${file()}.bak`, full);
  fs.writeFileSync(file(), torn);
  await import("./workspace-store");
  const after = fs.readdirSync(home).sort();

  vi.resetModules();
  await import("./workspace-store");
  expect(fs.readdirSync(home).sort()).toEqual(after);
  expect(read("local-code.json")).toBe(full);
  expect(read("local-code.json.bak")).toBe(full);
});

it("a failed save never throws: it is retried until it lands, newest values winning", async () => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    fs.writeFileSync(file(), full);
    const { workspaceStore, onStoreSaveFailing } =
      await import("./workspace-store");
    const failing = vi.fn();
    onStoreSaveFailing(failing);
    writes = [];

    failingWrites = 2;
    expect(() =>
      workspaceStore.set("localCode.agentSessions", [{ id: "s1" }])
    ).not.toThrow();
    workspaceStore.set("localCode.activeWorkspaceId", "w1");
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes).toEqual([
      {
        "localCode.agentSessions": [{ id: "s1" }],
        "localCode.activeWorkspaceId": "w1",
      },
    ]);
    expect(failing).not.toHaveBeenCalled();

    // Failing for a minute: the user is told once.
    failingWrites = Number.POSITIVE_INFINITY;
    workspaceStore.set("localCode.activeWorkspaceId", "w2");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(failing).toHaveBeenCalledOnce();
    failingWrites = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writes.at(-1)).toEqual({ "localCode.activeWorkspaceId": "w2" });
  } finally {
    error.mockRestore();
    vi.useRealTimers();
  }
});
