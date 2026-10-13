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

const asides = () =>
  fs.readdirSync(home).filter((name) => name.startsWith("local-code.json."));

it("keeps a copy of a torn local-code.json before the store opens it", async () => {
  const torn = '{"localCode.workspaces":[{"id":"w1","path":"/p"}],"local';
  fs.writeFileSync(path.join(home, "local-code.json"), torn);

  await import("./workspace-store");
  expect(seen).toBe(torn);
  const [aside, ...more] = asides();
  expect(aside).toMatch(/^local-code\.json\.corrupt-\d+$/);
  expect(more).toEqual([]);
  expect(fs.readFileSync(path.join(home, aside!), "utf8")).toBe(torn);
});

it("copies nothing for a file that parses", async () => {
  fs.writeFileSync(
    path.join(home, "local-code.json"),
    JSON.stringify({ "localCode.workspaces": [] })
  );
  await import("./workspace-store");
  expect(asides()).toEqual([]);
});
