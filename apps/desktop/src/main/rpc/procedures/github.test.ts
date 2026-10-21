import { afterEach, describe, expect, it, vi } from "vitest";

import { PrefsStore } from "../../services/config/prefs-store";
import type { GhRunner } from "../../services/workspace/github-cli";
import { GithubService } from "../../services/workspace/github-service";
import {
  connectInProcess,
  fakeDeps,
  type InProcessConnection,
} from "../testing";

const connections: InProcessConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) {
    connection.closeClient();
    connection.closeServer();
  }
});

const context = { workspaceId: "ws-1" };
const target = { context, number: 7 };

const setup = (options: { enabled?: boolean; checkout?: string | null }) => {
  const prefsStore = new PrefsStore({ file: null });
  if (options.enabled === false)
    prefsStore.update({ githubIntegration: false });
  const run = vi.fn<GhRunner>(async (args) => {
    const line = args.join(" ");
    if (line === "pr view --json number")
      return { stdout: '{"number":7}', stderr: "", truncated: false };
    if (line.startsWith("pr view --json"))
      return {
        stdout: JSON.stringify({
          number: 7,
          url: "https://x/7",
          state: "OPEN",
        }),
        stderr: "",
        truncated: false,
      };
    if (line === "--version")
      return { stdout: "gh version 2.102.0", stderr: "", truncated: false };
    if (line.startsWith("auth status"))
      return {
        stdout:
          '{"hosts":{"github.com":[{"state":"success","active":true,"login":"octocat"}]}}',
        stderr: "",
        truncated: false,
      };
    return { stdout: "", stderr: "", truncated: false };
  });
  const getPrInfo = vi.fn(async () => null);
  const connection = connectInProcess(
    fakeDeps({
      prefsStore,
      serviceHost: {
        github: new GithubService({ run }),
        gitContextPath: () =>
          options.checkout === undefined ? "/repo" : options.checkout,
        getPrInfo,
      },
    }),
    { transport: "message-port", windowKind: "main", webContentsId: 1 }
  );
  connections.push(connection);
  return { client: connection.client, run, getPrInfo };
};

describe("with GitHub integration off", () => {
  it("never runs gh and answers disabled", async () => {
    const { client, run, getPrInfo } = setup({ enabled: false });
    const disabled = {
      state: "disabled",
      version: null,
      account: null,
      host: null,
      message: null,
    };
    expect(await client.github.status({ refresh: true })).toEqual(disabled);
    expect(await client.github.pr(context)).toEqual({
      kind: "unavailable",
      status: disabled,
    });
    expect(await client.git.prInfo(context)).toBeNull();
    for (const call of [
      () => client.github.prDiff(target),
      () => client.github.review({ ...target, verdict: "approve", body: "" }),
    ])
      await expect(call()).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "GitHub integration is off",
        data: { reason: "github-disabled" },
      });
    expect(run).not.toHaveBeenCalled();
    expect(getPrInfo).not.toHaveBeenCalled();
  });
});

describe("with GitHub integration on", () => {
  it("reads status, the pull request and the summary", async () => {
    const { client, getPrInfo } = setup({});
    expect(await client.github.status()).toMatchObject({
      state: "ok",
      account: "octocat",
    });
    expect(await client.github.pr(context)).toMatchObject({
      kind: "ok",
      pr: { number: 7 },
    });
    await client.git.prInfo(context);
    expect(getPrInfo).toHaveBeenCalledOnce();
  });

  it("reviews the checkout's pull request, and diffs one by number", async () => {
    const { client, run } = setup({});
    expect(
      await client.github.review({ ...target, verdict: "comment", body: "Nit" })
    ).toEqual({ ok: true });
    await client.github.prDiff(target);
    expect(run.mock.calls.map(([args]) => args.slice(0, 2).join(" "))).toEqual([
      "pr view",
      "pr review",
      "pr diff",
    ]);
  });

  it("maps refusals onto the contract's errors", async () => {
    const { client } = setup({});
    await expect(
      client.github.review({ ...target, verdict: "comment", body: " " })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.github.review({
        ...target,
        number: 8,
        verdict: "approve",
        body: "",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "pr-mismatch" },
    });
  });

  it("is unsupported, or NOT_FOUND for an action, without a local checkout", async () => {
    const { client, run } = setup({ checkout: null });
    expect(await client.github.pr(context)).toEqual({ kind: "unsupported" });
    await expect(client.github.prDiff(target)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(run).not.toHaveBeenCalled();
  });
});
