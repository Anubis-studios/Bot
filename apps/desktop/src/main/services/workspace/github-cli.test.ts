import { describe, expect, it } from "vitest";

import {
  classifyGhFailure,
  parseAuthStatusJson,
  parseAuthStatusText,
  parseGhVersion,
  resolveGhBinary,
} from "./github-cli";

describe("classifyGhFailure", () => {
  it.each([
    [{ code: "ENOENT" }, "missing"],
    [{ killed: true, signal: "SIGTERM" }, "timeout"],
    [
      {
        code: 4,
        stderr:
          "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable.",
      },
      "unauthenticated",
    ],
    [
      {
        code: 1,
        stderr:
          "HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login -h github.com",
      },
      "unauthenticated",
    ],
    [
      { code: 1, stderr: 'no pull requests found for branch "feat/x"\n' },
      "none",
    ],
    [
      {
        code: 1,
        stderr:
          "could not determine current branch: failed to run git: not on any branch",
      },
      "none",
    ],
    [
      {
        code: 1,
        stderr:
          "failed to run git: fatal: not a git repository (or any of the parent directories): .git",
      },
      "unsupported",
    ],
    [{ code: 1, stderr: "no git remotes found" }, "unsupported"],
    [
      {
        code: 1,
        stderr:
          "none of the git remotes configured for this repository point to a known GitHub host.",
      },
      "unsupported",
    ],
    [
      {
        code: 1,
        stderr:
          "failed to create review: GraphQL: Can not approve your own pull request (addPullRequestReview)",
      },
      "error",
    ],
  ] as const)("%j is %s", (failure, kind) => {
    expect(classifyGhFailure(failure).kind).toBe(kind);
  });

  it("carries gh's first stderr line as the message", () => {
    const error = classifyGhFailure({
      code: 1,
      stderr:
        "\n  failed to create review: Can not approve your own pull request\nmore",
    });
    expect(error.message).toBe(
      "failed to create review: Can not approve your own pull request"
    );
  });

  it("falls back to the process error without stderr", () => {
    expect(classifyGhFailure({ code: 2, message: "boom" }).message).toBe(
      "boom"
    );
  });
});

describe("parseGhVersion", () => {
  it("reads the number", () => {
    expect(
      parseGhVersion(
        "gh version 2.102.0 (2026-09-30)\nhttps://github.com/cli/cli/releases/tag/v2.102.0\n"
      )
    ).toBe("2.102.0");
    expect(parseGhVersion("gh version 2.40.1-pre.1 (2023-12-13)")).toBe(
      "2.40.1-pre.1"
    );
    expect(parseGhVersion("something else")).toBeNull();
  });
});

describe("parseAuthStatusJson", () => {
  it("reads the active working login", () => {
    expect(
      parseAuthStatusJson(
        JSON.stringify({
          hosts: {
            "github.com": [
              {
                state: "success",
                active: true,
                host: "github.com",
                login: "octocat",
                tokenSource: "keyring",
              },
            ],
          },
        })
      )
    ).toEqual({
      signedIn: true,
      account: "octocat",
      host: "github.com",
      message: null,
    });
  });

  it("is signed out with no hosts", () => {
    expect(parseAuthStatusJson('{"hosts":{}}')).toMatchObject({
      signedIn: false,
      account: null,
    });
  });

  it("follows the active account even when another login works", () => {
    const auth = parseAuthStatusJson(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "error",
              error: "401 Unauthorized",
              active: true,
              host: "github.com",
              login: "",
              tokenSource: "GH_TOKEN",
            },
            {
              state: "success",
              active: false,
              host: "github.com",
              login: "octocat",
            },
          ],
        },
      })
    );
    expect(auth?.signedIn).toBe(false);
    expect(auth?.message).toMatch(/github\.com/);
  });

  it("takes any working login when none is active", () => {
    expect(
      parseAuthStatusJson(
        JSON.stringify({
          hosts: {
            "ghe.acme.com": [{ state: "success", active: false, login: "dev" }],
          },
        })
      )
    ).toMatchObject({ signedIn: true, account: "dev", host: "ghe.acme.com" });
  });

  it("is null for anything else, so the text form decides", () => {
    expect(parseAuthStatusJson("unknown flag: --json")).toBeNull();
    expect(parseAuthStatusJson("[]")).toBeNull();
  });
});

describe("parseAuthStatusText", () => {
  it("reads the current format", () => {
    expect(
      parseAuthStatusText(
        [
          "github.com",
          "  ✓ Logged in to github.com account old-me (keyring)",
          "  - Active account: false",
          "  ✓ Logged in to github.com account octocat (keyring)",
          "  - Active account: true",
          "  - Git operations protocol: https",
        ].join("\n"),
        true
      )
    ).toEqual({
      signedIn: true,
      account: "octocat",
      host: "github.com",
      message: null,
    });
  });

  it("reads the older format", () => {
    expect(
      parseAuthStatusText(
        "github.com\n  ✓ Logged in to github.com as octocat (oauth_token)\n  ✓ Git operations for github.com configured to use https protocol.",
        true
      )
    ).toMatchObject({ signedIn: true, account: "octocat", host: "github.com" });
  });

  it("is signed out on a failed exit", () => {
    expect(
      parseAuthStatusText(
        "You are not logged into any GitHub hosts. To log in, run: gh auth login",
        false
      )
    ).toMatchObject({ signedIn: false });
  });
});

describe("resolveGhBinary", () => {
  const only =
    (...present: string[]) =>
    (candidate: string): boolean =>
      present.includes(candidate);

  it("prefers PATH", () => {
    expect(
      resolveGhBinary(
        { PATH: "/custom/bin:/usr/bin" },
        "darwin",
        only("/custom/bin/gh", "/opt/homebrew/bin/gh"),
        "/Users/me"
      )
    ).toBe("/custom/bin/gh");
  });

  it("finds Homebrew and ~/.local/bin when PATH is the bare GUI one", () => {
    expect(
      resolveGhBinary(
        { PATH: "/usr/bin:/bin" },
        "darwin",
        only("/opt/homebrew/bin/gh"),
        "/Users/me"
      )
    ).toBe("/opt/homebrew/bin/gh");
    expect(
      resolveGhBinary(
        { PATH: "/usr/bin:/bin" },
        "linux",
        only("/home/me/.local/bin/gh"),
        "/home/me"
      )
    ).toBe("/home/me/.local/bin/gh");
  });

  it("finds gh.exe on Windows, under Program Files without PATH", () => {
    expect(
      resolveGhBinary(
        { Path: "C:\\Tools", ProgramFiles: "C:\\Program Files" },
        "win32",
        only("C:\\Program Files\\GitHub CLI\\gh.exe"),
        "C:\\Users\\me"
      )
    ).toBe("C:\\Program Files\\GitHub CLI\\gh.exe");
    expect(
      resolveGhBinary(
        { Path: "C:\\Tools" },
        "win32",
        only("C:\\Tools\\gh.exe"),
        "C:\\Users\\me"
      )
    ).toBe("C:\\Tools\\gh.exe");
  });

  it("is null when there is none", () => {
    expect(
      resolveGhBinary({ PATH: "/usr/bin" }, "darwin", () => false)
    ).toBeNull();
  });
});
