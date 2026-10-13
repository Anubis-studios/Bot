import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;
/** What `local-code.json` held when the store was opened. */
let seen: string | null = null;

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
    set() {}
    delete() {}
  },
}));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-store-"));
  process.env.ABACUSAI_BOT_HOME = home;
  seen = null;
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
