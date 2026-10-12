import { execFileSync } from "node:child_process";
/**
 * The workspace containment on the file operations the tree exposes.
 *
 * It used to be a case-sensitive startsWith on unresolved paths, which is
 * wrong in both directions: on the case-insensitive filesystems of macOS and
 * Windows the same directory spelled with different casing was rejected, and a
 * symlink inside the workspace pointing out of it sailed through. These pin
 * the corrected behavior: real paths, `path.relative`, case folded where the
 * filesystem folds it.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setMigrationWriteBlocks } from "../../migrations/write-block";
import { FileTreeService } from "./file-tree-service";
import { GitService } from "./git-service";

vi.mock("electron", () => ({
  shell: {
    trashItem: vi.fn(async (file: string) => {
      const { rmSync: remove } = await import("node:fs");
      remove(file, { recursive: true, force: true });
    }),
  },
}));

const onCaseInsensitiveFs =
  process.platform === "darwin" || process.platform === "win32";

let workspace: string;
let outside: string;
let service: FileTreeService;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ft-ws-"));
  outside = mkdtempSync(join(tmpdir(), "ft-out-"));
  service = new FileTreeService();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("writing a file through the tree", () => {
  it("lands inside the workspace", async () => {
    const result = await service.writeFile(workspace, "notes.txt", "hello");

    expect(result).toEqual({ success: true });
  });

  it("refuses a relative path that climbs out", async () => {
    const result = await service.writeFile(workspace, "../escape.txt", "x");

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
  });

  it("refuses an absolute path outside the workspace", async () => {
    const result = await service.writeFile(
      workspace,
      join(outside, "escape.txt"),
      "x"
    );

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
  });

  it("refuses a write through a symlink that leaves the workspace", async () => {
    // The link resolves inside the workspace lexically; only following it
    // shows where the bytes would land.
    symlinkSync(outside, join(workspace, "sneaky"));

    const result = await service.writeFile(workspace, "sneaky/escape.txt", "x");

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
  });

  it("refuses a write through a DANGLING link that points out of the workspace", async () => {
    // The target does not exist, so realpath fails on the link exactly as it
    // does on a plain missing file, but writing the link creates its target,
    // outside the workspace, rather than a file where the link sits.
    const target = join(outside, "created-by-the-write.txt");
    symlinkSync(target, join(workspace, "notes.txt"));

    const result = await service.writeFile(workspace, "notes.txt", "x");

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
    expect(existsSync(target)).toBe(false);
  });

  it("still creates an ordinary new file", async () => {
    // The dangling-link handling must not turn every create into a refusal.
    const result = await service.writeFile(workspace, "brand-new.txt", "x");

    expect(result).toEqual({ success: true });
  });

  it("refuses a write through a link loop instead of trusting its own path", async () => {
    const loop = join(workspace, "loop.txt");
    symlinkSync(loop, loop);

    const result = await service.writeFile(workspace, "loop.txt", "x");

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
  });

  it.runIf(onCaseInsensitiveFs)(
    "accepts the workspace spelled with different casing",
    async () => {
      // Same directory on a case-insensitive filesystem; a case-sensitive
      // string comparison called it a different one and rejected the write.
      const differentlyCased = join(
        dirname(workspace),
        basename(workspace).toUpperCase()
      );

      const result = await service.writeFile(
        differentlyCased,
        "notes.txt",
        "hello"
      );

      expect(result).toEqual({ success: true });
    }
  );

  it.runIf(process.platform === "darwin")(
    "treats a workspace reached through /tmp as itself",
    async () => {
      // /tmp is a symlink to /private/tmp on macOS: the same directory under
      // two spellings, which real paths reconcile.
      const linked = mkdtempSync("/tmp/ft-linked-");
      try {
        const result = await service.writeFile(linked, "notes.txt", "hello");

        expect(result).toEqual({ success: true });
      } finally {
        rmSync(linked, { recursive: true, force: true });
      }
    }
  );
});

describe("renaming a file through the tree", () => {
  it("moves a file within the workspace", async () => {
    writeFileSync(join(workspace, "a.txt"), "x");

    const result = await service.renameFile(workspace, "a.txt", "b.txt");

    expect(result).toEqual({ success: true });
  });

  it("refuses a destination outside the workspace", async () => {
    writeFileSync(join(workspace, "a.txt"), "x");

    const result = await service.renameFile(workspace, "a.txt", "../a.txt");

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
  });

  it("refuses a destination inside a symlinked escape hatch", async () => {
    writeFileSync(join(workspace, "a.txt"), "x");
    symlinkSync(outside, join(workspace, "sneaky"));

    const result = await service.renameFile(workspace, "a.txt", "sneaky/a.txt");

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
  });
});

describe("saving a resolved conflict", () => {
  it("writes inside the workspace", async () => {
    mkdirSync(join(workspace, "src"));

    const result = await service.saveResolvedConflict(
      workspace,
      "src/app.ts",
      "merged"
    );

    expect(result).toEqual({ success: true });
  });

  it("refuses a path outside the workspace", async () => {
    const result = await service.saveResolvedConflict(
      workspace,
      "../app.ts",
      "merged"
    );

    expect(result).toEqual({ success: false, error: "Path outside workspace" });
  });
});

describe("files held by an unresolved migration commit", () => {
  const held =
    "Held by an unfinished data migration; try again after restarting the app";
  let prefs: string;
  let threads: string;

  beforeEach(() => {
    // The app's home opened as a workspace, with prefs.json and a thread held.
    prefs = join(workspace, "prefs.json");
    threads = join(workspace, "threads");
    mkdirSync(threads);
    writeFileSync(prefs, "OLD");
    writeFileSync(join(threads, "a.json"), "A");
    writeFileSync(join(workspace, "free.txt"), "F");
    setMigrationWriteBlocks({
      unresolved: [
        {
          staging: "s",
          id: 2,
          name: "x",
          destinations: [prefs, join(threads, "a.json")],
          error: "",
        },
      ],
    });
  });

  afterEach(() => {
    setMigrationWriteBlocks(null);
  });

  it("refuses writes and conflict saves to a held file, in any spelling", async () => {
    expect(await service.writeFile(workspace, "prefs.json", "NEW")).toEqual({
      success: false,
      error: held,
    });
    expect(await service.writeFile(workspace, prefs, "NEW")).toMatchObject({
      success: false,
    });
    expect(
      await service.saveResolvedConflict(workspace, "threads/a.json", "NEW")
    ).toMatchObject({ success: false, error: held });
    // Through a symlinked directory.
    symlinkSync(threads, join(workspace, "alias"));
    expect(
      await service.writeFile(workspace, "alias/a.json", "NEW")
    ).toMatchObject({ success: false, error: held });
    if (onCaseInsensitiveFs)
      expect(
        await service.writeFile(workspace, "PREFS.JSON", "NEW")
      ).toMatchObject({ success: false, error: held });
    expect(readFileSync(prefs, "utf8")).toBe("OLD");
    expect(await service.writeFile(workspace, "free.txt", "G")).toEqual({
      success: true,
    });
  });

  it("refuses renames from, onto, or of a directory holding a held file", async () => {
    for (const [from, to] of [
      ["prefs.json", "moved.json"],
      ["free.txt", "prefs.json"],
      ["threads", "old-threads"],
      ["free.txt", "threads/a.json"],
    ] as const)
      expect(await service.renameFile(workspace, from, to)).toEqual({
        success: false,
        error: held,
      });
    expect(existsSync(join(threads, "a.json"))).toBe(true);
    expect(
      await service.renameFile(workspace, "free.txt", "free2.txt")
    ).toEqual({ success: true });
  });

  it("refuses to trash a held file or a directory holding one", async () => {
    expect(await service.trashFile(workspace, "prefs.json")).toEqual({
      success: false,
      error: held,
    });
    expect(await service.trashFile(workspace, "threads")).toEqual({
      success: false,
      error: held,
    });
    expect(existsSync(prefs)).toBe(true);
    expect(await service.trashFile(workspace, "free.txt")).toEqual({
      success: true,
    });
  });

  it("holds everything when an attempt's destinations are unknown", async () => {
    setMigrationWriteBlocks({
      unresolved: [
        { staging: "s", id: null, name: null, destinations: null, error: "" },
      ],
    });
    expect(await service.writeFile(workspace, "free.txt", "G")).toMatchObject({
      success: false,
      error: held,
    });
  });
});

/**
 * The Default workspace lives in the app's own folder, which can sit inside a
 * repository above it: a home folder kept in git. Git then reported the whole
 * workspace as one untracked `./`, the visibility filter matched none of its
 * folders, and the Files pane was blank; the status read scanned the whole
 * home repository. Real git throughout.
 */
describe("a workspace inside a larger repository", () => {
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    }).toString();
  let home: string;
  let base: string;
  let defaultWorkspace: string;
  const originalCeilings = process.env.GIT_CEILING_DIRECTORIES;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ft-home-"));
    run(home, "init", "-q");
    writeFileSync(join(home, "notes.txt"), "the user's own file\n");
    base = join(home, ".abacusai-bot");
    defaultWorkspace = join(base, "session-home");
    mkdirSync(join(defaultWorkspace, "ember-oak", "assets"), {
      recursive: true,
    });
    writeFileSync(join(defaultWorkspace, "ember-oak", "index.html"), "<h1/>");
    writeFileSync(join(defaultWorkspace, "ember-oak", "assets", "a.png"), "x");
  });

  afterEach(() => {
    if (originalCeilings == null) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = originalCeilings;
    rmSync(home, { recursive: true, force: true });
  });

  const names = async (root: string) =>
    (await new FileTreeService().buildRootTree(root, [])).map((n) => n.name);

  it("lists the folders of a workspace the repository does not track", async () => {
    expect(await names(defaultWorkspace)).toEqual(["ember-oak"]);
  });

  it("still hides what the workspace's own repository ignores", async () => {
    run(defaultWorkspace, "init", "-q");
    mkdirSync(join(defaultWorkspace, "build"));
    writeFileSync(join(defaultWorkspace, "build", "out.js"), "x");
    writeFileSync(join(defaultWorkspace, ".gitignore"), "build/\n");

    expect(await names(defaultWorkspace)).toEqual(["ember-oak", ".gitignore"]);
  });

  it("reads git changes for the workspace only, never the rest of the repository", async () => {
    const git = new GitService();
    const relative = await git.readGitChanges(defaultWorkspace, {
      checkoutRelative: true,
    });
    const whole = await new GitService().readGitChanges(defaultWorkspace);

    expect(relative.changes.map((c) => c.path)).toEqual([
      "ember-oak/assets/a.png",
      "ember-oak/index.html",
    ]);
    expect(whole.changes.map((c) => c.path)).not.toContain("notes.txt");
  });

  it("with the app's folder as a ceiling, the Default workspace is a plain folder that lists everything", async () => {
    // Even a home repository that ignores everything cannot hide it.
    writeFileSync(join(home, ".gitignore"), "*\n");
    process.env.GIT_CEILING_DIRECTORIES = base;

    expect(
      (await new GitService().readGitChanges(defaultWorkspace)).available
    ).toBe(false);
    expect(await names(defaultWorkspace)).toEqual(["ember-oak"]);
  });

  it("under the ceiling, a workspace with its own repository keeps it", async () => {
    process.env.GIT_CEILING_DIRECTORIES = base;
    run(defaultWorkspace, "init", "-q");

    const changes = await new GitService().readGitChanges(defaultWorkspace, {
      checkoutRelative: true,
    });
    expect(changes.available).toBe(true);
    expect(changes.changes.map((c) => [c.status, c.path])).toEqual([
      ["??", "ember-oak/assets/a.png"],
      ["??", "ember-oak/index.html"],
    ]);
  });
});
