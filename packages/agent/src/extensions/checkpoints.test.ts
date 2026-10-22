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
import { hasRecycleBin } from "../trash-shim.js";
import { setTrashMover } from "../trash.js";
import {
  bashTargets,
  callTargets,
  checkpoints,
  unmentionedChanges,
} from "./checkpoints.js";
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

  it("never refuse a write whose target is too big to copy: the result names it", async () => {
    setup({ maxFileBytes: 4 });
    fs.writeFileSync(at("big.bin"), "0123456789");
    tracker.beginTurn();
    const { blocked, result } = await call(
      "write",
      { path: "big.bin", content: "x" },
      () => fs.writeFileSync(at("big.bin"), "x")
    );
    expect(blocked).toBeUndefined();
    expect(fs.readFileSync(at("big.bin"), "utf8")).toBe("x");
    expect(resultText(result)).toContain("no checkpoint fully covers");
    expect(resultText(result)).toContain("big.bin");
  });

  it("never refuse an edit when the store cannot be written: the result says so", async () => {
    fs.writeFileSync(at("a.txt"), "1");
    // The store's folder is a file: nothing can be kept, as on a full disk.
    fs.mkdirSync(path.join(base, "app"), { recursive: true });
    fs.writeFileSync(path.join(base, "app", "checkpoints"), "");
    setup();
    tracker.beginTurn();
    const { blocked, result } = await call(
      "edit",
      { path: "a.txt", oldText: "1", newText: "2" },
      () => fs.writeFileSync(at("a.txt"), "2")
    );
    expect(blocked).toBeUndefined();
    expect(fs.readFileSync(at("a.txt"), "utf8")).toBe("2");
    expect(resultText(result)).toContain("could not be written");
    // The turn still settles without throwing into the run.
    await settle();
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
  /** A turn that created `made.txt`, then the agent's restore of it. */
  const restoreCreated = async (): Promise<string> => {
    tracker.beginTurn();
    await call("bash", { command: "./make" }, () =>
      fs.writeFileSync(at("made.txt"), "new")
    );
    await settle();
    tracker.beginTurn();
    const answer = await pi.tools
      .get("restore_checkpoint")!
      .execute("r", { turn: 1 }, undefined, undefined, ctx());
    await settle();
    return answer.content[0]?.text ?? "";
  };

  it("sends a file the turn created to the trash", async () => {
    const binned: string[] = [];
    setTrashMover(async (file) => {
      binned.push(file);
      fs.renameSync(file, path.join(base, "binned.txt"));
    });
    try {
      const text = await restoreCreated();

      expect(binned).toEqual([at("made.txt")]);
      expect(fs.existsSync(at("made.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(base, "binned.txt"), "utf8")).toBe(
        "new"
      );
      expect(text).not.toContain("permanently");
    } finally {
      setTrashMover(null);
    }
  });

  // The test folder is under the temp dir, so on Windows its drive has a Recycle Bin.
  const windowsWithBin =
    process.platform === "win32" && hasRecycleBin(os.tmpdir());

  it.skipIf(windowsWithBin)(
    "deletes it anyway when the trash refuses, and says so",
    async () => {
      setTrashMover(async () => {
        throw new Error("no Trash on this drive");
      });
      try {
        const text = await restoreCreated();

        expect(fs.existsSync(at("made.txt"))).toBe(false);
        expect(text).toContain("no Trash on this drive");
        expect(text).toContain("deleted it permanently instead");
      } finally {
        setTrashMover(null);
      }
    }
  );

  it.runIf(windowsWithBin)(
    "leaves it in place when Windows will not recycle it, and says so",
    async () => {
      setTrashMover(async () => {
        throw new Error("Operation was aborted");
      });
      try {
        const text = await restoreCreated();

        expect(fs.existsSync(at("made.txt"))).toBe(true);
        expect(text).toContain("Operation was aborted");
        expect(text).toContain("left it in place");
      } finally {
        setTrashMover(null);
      }
    }
  );
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
    const { result: shell } = await call("bash", { command: "./rewrite" }, () =>
      fs.writeFileSync(at("big.txt"), "x")
    );
    // The command ran; its result says the folder is past the cap.
    expect(resultText(shell)).toContain("file or size cap");
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

describe("the scope check after a turn", () => {
  /** A user turn: the prompt, the run's calls, a normal end, the settle. */
  async function userTurn(
    text: string,
    work: () => Promise<unknown>,
    stopReason = "stop"
  ): Promise<void> {
    tracker.beginTurn();
    await pi.fire("input", { type: "input", text, source: "rpc" }, ctx());
    await work();
    await endAndSettle(stopReason);
  }

  async function endAndSettle(stopReason = "stop"): Promise<void> {
    await pi.fire(
      "agent_end",
      { messages: [{ role: "assistant", content: [], stopReason }] },
      ctx()
    );
    await settle();
  }

  const write = (rel: string, content: string) =>
    call("write", { path: rel, content }, () => {
      fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
      fs.writeFileSync(at(rel), content);
    });

  beforeEach(() => {
    fs.mkdirSync(at("src"), { recursive: true });
    fs.writeFileSync(at("src", "auth.ts"), "export const a = 1;\n");
    fs.writeFileSync(at("README.md"), "# readme\n");
    fs.writeFileSync(at("src", "theme.css"), "body {}\n");
  });

  it("sends exactly one note naming the files the user never mentioned", async () => {
    await userTurn("Fix the bug in auth.ts please", async () => {
      await write("src/auth.ts", "export const a = 2;\n");
      await write("README.md", "# changed\n");
      await write("src/theme.css", "body { color: red }\n");
    });

    expect(pi.userMessages).toHaveLength(1);
    const [note] = pi.userMessages;
    expect(note!.options).toEqual({ deliverAs: "followUp" });
    expect(note!.text).toContain("README.md, src/theme.css");
    expect(note!.text).not.toContain("auth.ts");
    expect(note!.text).toContain("restore_checkpoint({ turn: 1");
  });

  it("stays quiet when every change was asked for", async () => {
    await userTurn(
      "Fix the login check in src/auth.ts and the readme",
      async () => {
        await write("src/auth.ts", "export const a = 3;\n");
        await write("README.md", "# fixed\n");
      }
    );
    // A folder the user named covers what is inside it.
    await userTurn("Restyle everything under src/ for dark mode", () =>
      write("src/theme.css", "body { color: white }\n")
    );

    expect(pi.userMessages).toEqual([]);
  });

  it("never runs a second time in a turn, so its own follow-up cannot loop", async () => {
    await userTurn("Fix the bug in auth.ts please", () =>
      write("README.md", "# changed\n")
    );
    expect(pi.userMessages).toHaveLength(1);

    // The agent answers the note: pi delivers it as an extension prompt.
    await pi.fire(
      "input",
      { type: "input", text: pi.userMessages[0]!.text, source: "extension" },
      ctx()
    );
    await call(
      "restore_checkpoint",
      { turn: 1, paths: ["README.md"] },
      () => undefined
    );
    await pi.tools
      .get("restore_checkpoint")!
      .execute(
        "r",
        { turn: 1, paths: ["README.md"] },
        undefined,
        undefined,
        ctx()
      );
    // And it touches another file while at it: still no second note.
    await write("src/theme.css", "body { margin: 0 }\n");
    await endAndSettle();

    expect(pi.userMessages).toHaveLength(1);
    expect(fs.readFileSync(at("README.md"), "utf8")).toBe("# readme\n");
    expect((await turn(1)).files.map((f) => path.basename(f.path))).toEqual([
      "theme.css",
    ]);
  });

  it("starts fresh on the next turn", async () => {
    await userTurn("Fix the bug in auth.ts please", () =>
      write("README.md", "# one\n")
    );
    await userTurn("Now tidy auth.ts", () =>
      write("src/theme.css", "body { padding: 0 }\n")
    );

    expect(pi.userMessages).toHaveLength(2);
    expect(pi.userMessages[1]!.text).toContain("src/theme.css");
    expect(pi.userMessages[1]!.text).toContain("turn: 2");
    // README.md was this chat's earlier work, so turn 2 does not ask again.
    expect(pi.userMessages[1]!.text).not.toContain("README.md");
  });

  it("never blocks or alters a tool call, even an unmentioned one", async () => {
    tracker.beginTurn();
    await pi.fire(
      "input",
      { type: "input", text: "Fix the bug in auth.ts please", source: "rpc" },
      ctx()
    );
    const { blocked, result } = await write("src/theme.css", "a {}\n");

    expect(blocked).toBeUndefined();
    // The result goes back exactly as the tool made it.
    expect(result).toBeUndefined();
    expect(fs.readFileSync(at("src", "theme.css"), "utf8")).toBe("a {}\n");
  });

  it("says nothing after a stopped or failed run", async () => {
    await userTurn(
      "Fix the bug in auth.ts please",
      () => write("README.md", "# half\n"),
      "aborted"
    );
    await userTurn(
      "Fix the bug in auth.ts please",
      () => write("README.md", "# half again\n"),
      "error"
    );

    expect(pi.userMessages).toEqual([]);
  });

  it("counts a steer sent mid-turn as the user's words", async () => {
    tracker.beginTurn();
    await pi.fire(
      "input",
      { type: "input", text: "Fix the bug in auth.ts please", source: "rpc" },
      ctx()
    );
    await pi.fire(
      "message_start",
      {
        message: {
          role: "user",
          content: [{ type: "text", text: "also update the readme" }],
        },
      },
      ctx()
    );
    await write("README.md", "# steered\n");
    await endAndSettle();

    expect(pi.userMessages).toEqual([]);
  });

  it("leaves out build output, lockfiles, the app's own files and asked-for new files", () => {
    const changed = (rel: string, kind: "created" | "modified" = "modified") =>
      ({
        path: path.isAbsolute(rel) ? rel : at(rel),
        kind,
        before: null,
        after: null,
        binary: false,
        added: 1,
        removed: 0,
      }) as const;
    const scope = (text: string) => ({
      texts: [text],
      cwd,
      appHome: path.join(base, "app"),
      home,
      temp: path.join(base, "temp"),
    });
    const noise = [
      changed("package-lock.json"),
      changed("pnpm-lock.yaml"),
      changed("Cargo.lock"),
      changed("dist/app.js"),
      changed("node_modules/x/index.js"),
      changed("src/__pycache__/auth.cpython-312.pyc"),
      changed(path.join(base, "app", "memory", "notes.md")),
    ];

    expect(unmentionedChanges(noise, scope("Fix the bug in auth.ts"))).toEqual(
      []
    );
    // A new file is the deliverable when one was asked for, not otherwise.
    const created = [changed("src/auth.test.ts", "created")];
    expect(
      unmentionedChanges(created, scope("Write a test for the auth check"))
    ).toEqual([]);
    expect(
      unmentionedChanges(created, scope("Fix the off-by-one in the parser"))
    ).toHaveLength(1);
    // The workspace as a whole, or its folder by name, covers all of it.
    const readme = [changed("README.md")];
    expect(
      unmentionedChanges(readme, scope("Clean up this repo for release"))
    ).toEqual([]);
    expect(
      unmentionedChanges(readme, scope("Fix the parser in the code"))
    ).toHaveLength(1);
    // A name described in words counts; a file's folder named only inside its path does not.
    expect(
      unmentionedChanges(
        [changed("lib/paginate.js"), changed("src/UserProfile.tsx")],
        scope("The pagination helper skips a row on the user profile page")
      )
    ).toEqual([]);
    expect(
      unmentionedChanges(
        [changed("src/api.js")],
        scope("In src/users.js rename getUsr to getUser")
      )
    ).toHaveLength(1);
    // The app's `<system_reminder>` envelopes are not the user's words.
    expect(
      unmentionedChanges(
        readme,
        scope("Fix the parser\n\n<system_reminder>README.md</system_reminder>")
      )
    ).toHaveLength(1);
  });
});
