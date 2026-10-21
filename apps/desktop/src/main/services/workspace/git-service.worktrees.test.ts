import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitService, parseWorktreePorcelain } from "./git-service";

const execFileAsync = promisify(execFile);

let temporaryRoot = "";
let repositoryPath = "";
let managedRoot = "";
let gitService: GitService;

const git = (...args: string[]) =>
  execFileAsync("git", ["-C", repositoryPath, ...args]);

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "abacus-worktrees-"));
  repositoryPath = path.join(temporaryRoot, "repository");
  managedRoot = path.join(temporaryRoot, "managed");
  await fs.mkdir(repositoryPath);
  await git("init", "-b", "main");
  await git("config", "user.email", "worktrees@example.invalid");
  await git("config", "user.name", "Worktree Test");
  await fs.writeFile(path.join(repositoryPath, "README.md"), "ready\n");
  await git("add", "README.md");
  await git("commit", "-m", "initial");
  gitService = new GitService();
});

afterEach(async () => {
  if (repositoryPath.length > 0) {
    await git("worktree", "prune").catch(() => undefined);
  }
  if (temporaryRoot.length > 0) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

describe("Git worktrees", () => {
  it("parses NUL-delimited porcelain records without confusing branches and paths", () => {
    const secondary = path.join(managedRoot, "feature");
    const raw = [
      `worktree ${repositoryPath}`,
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      `worktree ${secondary}`,
      "HEAD def456",
      "branch refs/heads/feature/demo",
      "",
    ].join("\0");

    const rows = parseWorktreePorcelain(raw, repositoryPath, managedRoot);

    expect(rows).toEqual([
      expect.objectContaining({
        name: "repository",
        path: repositoryPath,
        branch: "main",
        isCurrent: true,
        isManaged: false,
      }),
      expect.objectContaining({
        name: "feature",
        path: secondary,
        branch: "feature/demo",
        isCurrent: false,
        isManaged: true,
      }),
    ]);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
  });

  it("creates collision-safe managed checkouts from the selected base ref", async () => {
    const first = await gitService.createWorktree(
      repositoryPath,
      managedRoot,
      "main",
      "Review changes"
    );
    const second = await gitService.createWorktree(
      repositoryPath,
      managedRoot,
      "main",
      "Review changes"
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.worktree).toMatchObject({
      branch: expect.stringMatching(/^abacus\/review-changes-/),
      isCurrent: false,
      isManaged: true,
    });
    expect(second.worktree?.path).not.toBe(first.worktree?.path);
    expect(second.worktree?.branch).not.toBe(first.worktree?.branch);
    await expect(
      fs.stat(path.join(first.worktree!.path, "README.md"))
    ).resolves.toBeDefined();

    const listed = await gitService.listWorktrees(repositoryPath, managedRoot);
    expect(listed.success).toBe(true);
    expect(listed.worktrees).toHaveLength(3);
    expect(listed.worktrees.filter((row) => row.isManaged)).toHaveLength(2);

    const firstBranch = await gitService.getCurrentBranch(first.worktree!.path);
    const secondBranch = await gitService.getCurrentBranch(
      second.worktree!.path
    );
    expect(firstBranch.currentBranch).toBe(first.worktree?.branch);
    expect(secondBranch.currentBranch).toBe(second.worktree?.branch);
  });

  it("rejects an unknown base without leaving a managed checkout", async () => {
    const result = await gitService.createWorktree(
      repositoryPath,
      managedRoot,
      "not-a-ref",
      "broken"
    );

    expect(result).toEqual({
      success: false,
      error: "The selected base ref does not exist.",
    });
    const children = await fs.readdir(managedRoot).catch(() => []);
    expect(children).toEqual([]);
  });

  it("hashes a large set of changed files a few at a time, within a low descriptor limit", async () => {
    const files = Array.from({ length: 300 }, (_, i) => `file-${i}.txt`);
    await Promise.all(
      files.map((name) =>
        fs.writeFile(path.join(repositoryPath, name), `${name}\n`)
      )
    );
    const expected = await gitService.readGitChanges(repositoryPath, {
      fingerprints: true,
    });

    // A process allowed 64 open files: past that, opens fail with EMFILE.
    const readFile = fs.readFile;
    let open = 0;
    let peak = 0;
    const spy = vi.spyOn(fs, "readFile").mockImplementation((async (
      ...args: Parameters<typeof fs.readFile>
    ) => {
      if (open >= 64)
        throw Object.assign(new Error("EMFILE: too many open files"), {
          code: "EMFILE",
        });
      open += 1;
      peak = Math.max(peak, open);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await readFile(...args);
      } finally {
        open -= 1;
      }
    }) as typeof fs.readFile);
    try {
      const status = await gitService.readGitChanges(repositoryPath, {
        fingerprints: true,
      });
      expect(status.changes).toHaveLength(300);
      expect(status.changes).toEqual(expected.changes);
      expect(peak).toBeLessThanOrEqual(32);
    } finally {
      spy.mockRestore();
    }
  });
});
