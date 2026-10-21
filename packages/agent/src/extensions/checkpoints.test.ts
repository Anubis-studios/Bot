/**
 * Turn checkpoints through the extension's own hooks: every write path is
 * captured before the call and undone byte for byte after it, and a restore
 * never overwrites what changed after the turn unless forced.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fakePi, type FakePi } from "@abacus-ai/test-support/fake-pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CheckpointBusyError,
  CheckpointStore,
  CheckpointTracker,
  isWalkRefused,
  lineCounts,
  pathKey,
} from "../checkpoint-store.js";
import { bashTargets, callTargets, checkpoints } from "./checkpoints.js";
import { syntaxCheck } from "./syntax-check.js";

let base: string;
let cwd: string;
let home: string;
let store: CheckpointStore;
let tracker: CheckpointTracker;
let pi: FakePi;
let calls = 0;

const ctx = () => ({ cwd });

const at = (...parts: string[]) => path.join(cwd, ...parts);

/** One tool call: the hook before, the change itself, the hook after. */
async function call(
  toolName: string,
  input: Record<string, unknown>,
  change: () => void = () => {}
): Promise<{ blocked: unknown; result: unknown }> {
  const toolCallId = `call-${++calls}`;
  const blocked = await pi.fire(
    "tool_call",
    { toolName, toolCallId, input },
    ctx()
  );
  if (blocked != null) return { blocked, result: undefined };
  change();
  const result = await pi.fire(
    "tool_result",
    {
      toolName,
      toolCallId,
      input,
      isError: false,
      content: [{ type: "text", text: "ok" }],
    },
    ctx()
  );
  return { blocked: undefined, result };
}

const settle = () => pi.fire("agent_settled", {}, ctx());

const turn = async (seq: number) => store.readTurn(tracker.sessionId, seq);

const resultText = (result: unknown): string =>
  ((result as { content?: Array<{ text: string }> } | undefined)?.content ?? [])
    .map((part) => part.text)
    .join("\n");

const setup = (
  limits: ConstructorParameters<typeof CheckpointStore>[1] = {}
) => {
  store = new CheckpointStore(path.join(base, "app", "checkpoints"), limits);
  tracker = new CheckpointTracker(store, "session-1", {
    home,
    temp: os.tmpdir(),
  });
  pi = fakePi();
  checkpoints(tracker)(pi.api as never);
  syntaxCheck(tracker)(pi.api as never);
};

beforeEach(() => {
  base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "checkpoints-test-"))
  );
  home = path.join(base, "home");
  cwd = path.join(home, "project");
  fs.mkdirSync(cwd, { recursive: true });
  setup();
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("what a shell command changes", () => {
  it("is undone for a python heredoc write the command never names", async () => {
    fs.writeFileSync(at("app.py"), "print('working')\n");
    tracker.beginTurn("m1");
    await call(
      "bash",
      {
        command: "python3 - <<'EOF'\nopen('app.py','w').write('broken(')\nEOF",
      },
      () => fs.writeFileSync(at("app.py"), "broken(")
    );
    await settle();

    const record = await turn(1);
    expect(record.messageId).toBe("m1");
    expect(record.files.map((f) => [path.basename(f.path), f.kind])).toEqual([
      ["app.py", "modified"],
    ]);

    const restored = await store.restore("session-1", 1);
    expect(restored.restored).toEqual([at("app.py")]);
    expect(fs.readFileSync(at("app.py"), "utf8")).toBe("print('working')\n");
  });

  it("is undone for sed -i, even when the size does not change", async () => {
    fs.writeFileSync(at("config.ini"), "mode=a\n");
    tracker.beginTurn();
    await call("bash", { command: "sed -i 's/a/b/' config.ini" }, () =>
      fs.writeFileSync(at("config.ini"), "mode=b\n")
    );
    await settle();

    expect((await turn(1)).files).toHaveLength(1);
    await store.restore("session-1", 1);
    expect(fs.readFileSync(at("config.ini"), "utf8")).toBe("mode=a\n");
  });

  it("covers a folder outside the workspace reached with cd", async () => {
    const elsewhere = path.join(home, "Desktop", "site");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "index.html"), "<h1>ok</h1>");
    tracker.beginTurn();
    await call("bash", { command: `cd "${elsewhere}" && node build.js` }, () =>
      fs.writeFileSync(path.join(elsewhere, "index.html"), "")
    );
    await settle();

    await store.restore("session-1", 1);
    expect(fs.readFileSync(path.join(elsewhere, "index.html"), "utf8")).toBe(
      "<h1>ok</h1>"
    );
  });

  it("puts a binary file back byte for byte", async () => {
    const bytes = Buffer.from([0, 255, 1, 254, 0, 128, 7]);
    fs.writeFileSync(at("logo.png"), bytes);
    tracker.beginTurn();
    await call("bash", { command: "convert logo.png logo.png" }, () =>
      fs.writeFileSync(at("logo.png"), Buffer.from([1, 2, 3]))
    );
    await settle();

    expect((await turn(1)).files[0]?.binary).toBe(true);
    await store.restore("session-1", 1);
    expect(fs.readFileSync(at("logo.png")).equals(bytes)).toBe(true);
  });

  it("records created and deleted files, and undoes both", async () => {
    fs.writeFileSync(at("old.txt"), "keep me");
    tracker.beginTurn();
    await call("bash", { command: "mv old.txt new.txt" }, () =>
      fs.renameSync(at("old.txt"), at("new.txt"))
    );
    await settle();

    const kinds = Object.fromEntries(
      (await turn(1)).files.map((f) => [path.basename(f.path), f.kind])
    );
    expect(kinds).toEqual({ "new.txt": "created", "old.txt": "deleted" });

    await store.restore("session-1", 1);
    expect(fs.readFileSync(at("old.txt"), "utf8")).toBe("keep me");
    expect(fs.existsSync(at("new.txt"))).toBe(false);
  });

  it("tells the next extension which files the command changed", async () => {
    fs.writeFileSync(at("data.json"), "{}");
    tracker.beginTurn();
    const { result } = await call("bash", { command: "./gen.sh" }, () =>
      fs.writeFileSync(at("data.json"), "{ broken")
    );
    expect(tracker.changedByLastCall()).toEqual([at("data.json")]);
    expect(resultText(result)).toContain("no longer valid JSON");
  });
});

describe("the file tools", () => {
  it("are captured before the edit, outside the workspace too", async () => {
    const notes = path.join(home, "notes", "todo.md");
    fs.mkdirSync(path.dirname(notes), { recursive: true });
    fs.writeFileSync(notes, "- one\n");
    tracker.beginTurn();
    await call("edit", { path: notes, oldText: "one", newText: "two" }, () =>
      fs.writeFileSync(notes, "- two\n")
    );
    await settle();

    const [file] = (await turn(1)).files;
    expect(file).toMatchObject({ kind: "modified", added: 1, removed: 1 });
    await store.restore("session-1", 1);
    expect(fs.readFileSync(notes, "utf8")).toBe("- one\n");
  });

  it("refuse a write whose target is too big to copy", async () => {
    setup({ maxFileBytes: 4 });
    fs.writeFileSync(at("big.bin"), "0123456789");
    tracker.beginTurn();
    const { blocked } = await call("write", { path: "big.bin", content: "x" });
    expect(blocked).toMatchObject({ block: true });
    expect((blocked as { reason: string }).reason).toContain("big.bin");
  });

  it("merge a follow-up run of the same turn into one record", async () => {
    fs.writeFileSync(at("a.txt"), "1");
    tracker.beginTurn("m1");
    await call("write", { path: "a.txt", content: "2" }, () =>
      fs.writeFileSync(at("a.txt"), "2")
    );
    await settle();
    await call("write", { path: "a.txt", content: "3" }, () =>
      fs.writeFileSync(at("a.txt"), "3")
    );
    await settle();

    expect(await store.listTurns("session-1")).toHaveLength(1);
    await store.restore("session-1", 1);
    expect(fs.readFileSync(at("a.txt"), "utf8")).toBe("1");
  });
});

describe("restoring", () => {
  it("leaves a file changed after the turn alone unless forced", async () => {
    fs.writeFileSync(at("a.txt"), "before");
    fs.writeFileSync(at("b.txt"), "before");
    tracker.beginTurn();
    await call("bash", { command: "./edit-both" }, () => {
      fs.writeFileSync(at("a.txt"), "turn one");
      fs.writeFileSync(at("b.txt"), "turn one");
    });
    await settle();
    // The user, or a later turn, edits one of them again.
    fs.writeFileSync(at("b.txt"), "later work");

    const first = await store.restore("session-1", 1, { record: true });
    expect(first.restored).toEqual([at("a.txt")]);
    expect(first.conflicts).toEqual([at("b.txt")]);
    expect(fs.readFileSync(at("b.txt"), "utf8")).toBe("later work");

    const forced = await store.restore("session-1", 1, {
      paths: [at("b.txt")],
      force: true,
      record: true,
    });
    expect(forced.restored).toEqual([at("b.txt")]);
    expect(fs.readFileSync(at("b.txt"), "utf8")).toBe("before");

    // The forced restore is itself undoable: the later work comes back.
    await store.restore("session-1", forced.restoreSeq!);
    expect(fs.readFileSync(at("b.txt"), "utf8")).toBe("later work");
  });

  it("is refused from outside while a turn is capturing", async () => {
    fs.writeFileSync(at("a.txt"), "1");
    tracker.beginTurn();
    await call("write", { path: "a.txt", content: "2" }, () =>
      fs.writeFileSync(at("a.txt"), "2")
    );
    await settle();
    tracker.beginTurn();
    await call("write", { path: "a.txt", content: "3" }, () =>
      fs.writeFileSync(at("a.txt"), "3")
    );

    await expect(store.restore("session-1", 1)).rejects.toBeInstanceOf(
      CheckpointBusyError
    );
    await settle();
    await expect(store.restore("session-1", 1)).resolves.toMatchObject({
      conflicts: [at("a.txt")],
    });
  });

  it("is what the agent's restore_checkpoint tool does", async () => {
    fs.writeFileSync(at("app.js"), "ok()");
    tracker.beginTurn();
    await call("bash", { command: "./break" }, () =>
      fs.writeFileSync(at("app.js"), "oops(")
    );
    await settle();

    const tool = pi.tools.get("restore_checkpoint")!;
    tracker.beginTurn();
    await pi.fire(
      "tool_call",
      { toolName: "restore_checkpoint", toolCallId: "r", input: { turn: 1 } },
      ctx()
    );
    const answer = await tool.execute(
      "r",
      { turn: 1 },
      undefined,
      undefined,
      ctx()
    );
    expect(answer.content[0]?.text).toContain("Restored 1 file");
    expect(fs.readFileSync(at("app.js"), "utf8")).toBe("ok()");
    await settle();

    // The agent's restore is the new turn's change, so it can be undone too.
    expect((await turn(2)).files.map((f) => f.path)).toEqual([at("app.js")]);
    const diff = await pi.tools
      .get("checkpoint_diff")!
      .execute("d", { turn: 1 }, undefined, undefined, ctx());
    expect(diff.content[0]?.text).toContain("-ok()");
    expect(diff.content[0]?.text).toContain("+oops(");
  });
});

describe("caps and retention", () => {
  it("marks a root partial past the file cap, and still keeps a named file", async () => {
    setup({ maxFilesPerRoot: 3 });
    for (const name of ["a", "b", "c", "d", "e"])
      fs.writeFileSync(at(`${name}.txt`), name);
    tracker.beginTurn();
    await call("write", { path: "e.txt", content: "E" }, () =>
      fs.writeFileSync(at("e.txt"), "E")
    );
    await settle();

    const record = await turn(1);
    expect(record.roots.some((root) => root.partial)).toBe(true);
    await store.restore("session-1", 1);
    expect(fs.readFileSync(at("e.txt"), "utf8")).toBe("e");
  });

  it("reports a file past the byte cap as one it cannot restore", async () => {
    setup({ maxBytesPerRoot: 4 });
    fs.writeFileSync(at("big.txt"), "0123456789");
    tracker.beginTurn();
    await call("bash", { command: "./rewrite" }, () =>
      fs.writeFileSync(at("big.txt"), "x")
    );
    await settle();

    const result = await store.restore("session-1", 1);
    expect(result.unrestorable).toEqual([at("big.txt")]);
    expect(fs.readFileSync(at("big.txt"), "utf8")).toBe("x");
  });

  it("never walks home or a folder above it, only the files named there", () => {
    expect(isWalkRefused(home, home, os.tmpdir())).toBe(true);
    expect(isWalkRefused(path.dirname(home), home, os.tmpdir())).toBe(true);
    expect(isWalkRefused(path.parse(home).root, home, os.tmpdir())).toBe(true);
    expect(isWalkRefused(cwd, home, os.tmpdir())).toBe(false);
  });

  it("skips node_modules and the like, and its own store", async () => {
    fs.mkdirSync(at("node_modules", "x"), { recursive: true });
    fs.writeFileSync(at("node_modules", "x", "index.js"), "1");
    tracker.beginTurn();
    await call("bash", { command: "npm install" }, () =>
      fs.writeFileSync(at("node_modules", "x", "index.js"), "2")
    );
    await settle();
    expect(await store.listTurns("session-1")).toEqual([]);
  });

  it("drops old sessions and the blobs only they referred to", async () => {
    fs.writeFileSync(at("a.txt"), "first");
    tracker.beginTurn();
    await call("write", { path: "a.txt", content: "second" }, () =>
      fs.writeFileSync(at("a.txt"), "second")
    );
    await settle();
    const blobs = () =>
      fs
        .readdirSync(path.join(store.dir, "blobs"))
        .flatMap((prefix) =>
          fs.readdirSync(path.join(store.dir, "blobs", prefix))
        );
    expect(blobs().length).toBeGreaterThan(0);

    const later = Date.now() + 40 * 24 * 60 * 60 * 1000;
    await store.collectGarbage(undefined, later, { force: true });
    expect(await store.listTurns("session-1")).toEqual([]);
    expect(blobs()).toEqual([]);
  });

  it("keeps at most the configured number of turns", async () => {
    setup({ maxTurnsPerSession: 2 });
    for (const value of ["1", "2", "3"]) {
      tracker.beginTurn();
      await call("write", { path: "a.txt", content: value }, () =>
        fs.writeFileSync(at("a.txt"), value)
      );
      await settle();
    }
    await store.collectGarbage(undefined, Date.now(), { force: true });
    expect((await store.listTurns("session-1")).map((t) => t.seq)).toEqual([
      2, 3,
    ]);
  });

  it("is collected after a settled turn too, not only at launch", async () => {
    setup({ maxTurnsPerSession: 1 });
    const collect = vi.spyOn(store, "collectGarbage");
    tracker.beginTurn();
    await call("write", { path: "a.txt", content: "1" }, () =>
      fs.writeFileSync(at("a.txt"), "1")
    );
    await settle();
    expect(collect).toHaveBeenCalledWith("session-1");
  });
});

describe("Windows paths", () => {
  it("compare case-folded, whichever separator", () => {
    expect(pathKey("C:\\Users\\Me\\App.py", "win32")).toBe(
      pathKey("c:/users/me/app.py", "win32")
    );
    expect(pathKey("/Users/Me/App.py", "darwin")).not.toBe(
      pathKey("/users/me/app.py", "darwin")
    );
  });

  it("never walk a drive root or the profile folder", () => {
    const profile = "C:\\Users\\Me";
    const temp = "C:\\Users\\Me\\AppData\\Local\\Temp";
    expect(isWalkRefused("C:\\", profile, temp, "win32")).toBe(true);
    expect(isWalkRefused("c:/users/me", profile, temp, "win32")).toBe(true);
    expect(isWalkRefused("C:\\Users", profile, temp, "win32")).toBe(true);
    expect(isWalkRefused(temp, profile, temp, "win32")).toBe(true);
    expect(
      isWalkRefused("C:\\Users\\Me\\Desktop\\site", profile, temp, "win32")
    ).toBe(false);
  });

  it("read a quoted cd into a drive path as a folder to cover", () => {
    const targets = bashTargets('cd "D:\\work\\site" && npm run build', cwd);
    expect(targets.map((t) => t.path)).toContain(
      path.resolve(cwd, "D:\\work\\site")
    );
  });
});

describe("which calls are covered", () => {
  it("maps each mutating tool to the folders it can reach", () => {
    expect(callTargets("read", { path: "a" }, cwd)).toBeNull();
    expect(callTargets("bash", { command: "ls" }, cwd)).toEqual([
      { path: cwd, kind: "dir" },
    ]);
    expect(callTargets("write", { path: "src/a.ts" }, cwd)).toEqual([
      { path: cwd, kind: "dir" },
      { path: at("src", "a.ts"), kind: "file" },
      { path: at("src"), kind: "dir" },
    ]);
    expect(callTargets("delegate_task", { task: "x" }, cwd)).toEqual([
      { path: cwd, kind: "dir" },
    ]);
  });

  it("counts lines added and removed", () => {
    expect(lineCounts("a\nb\nc", "a\nB\nc\nd")).toEqual({
      added: 2,
      removed: 1,
    });
  });
});
