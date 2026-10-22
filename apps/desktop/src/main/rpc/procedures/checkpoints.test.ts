/**
 * `checkpoints.*` read and restore what the agent recorded under the app
 * home, with no agent running: list, a file's diff, a restore that skips a
 * file changed since, NOT_FOUND for an unknown turn, CONFLICT mid-turn.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkpointsDirFor,
  CheckpointStore,
  CheckpointTracker,
} from "@abacus-ai/agent/checkpoint-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connectInProcess, fakeDeps, type TestClient } from "../testing";

const SESSION = "22222222-2222-4222-8222-222222222222";

let base = "";
let project = "";
let client: TestClient;
let close: () => void = () => undefined;
let previousHome: string | undefined;

/** One agent turn that rewrote both files, recorded the way the agent records it. */
const recordTurn = async (): Promise<CheckpointTracker> => {
  const tracker = new CheckpointTracker(
    new CheckpointStore(checkpointsDirFor(path.join(base, "app"))),
    SESSION,
    { home: path.join(base, "home"), temp: os.tmpdir() }
  );
  tracker.beginTurn("user-message-1");
  await tracker.capture([{ path: project, kind: "dir" }]);
  fs.writeFileSync(path.join(project, "a.txt"), "after\n");
  fs.writeFileSync(path.join(project, "b.txt"), "after\n");
  await tracker.settle();
  return tracker;
};

beforeEach(() => {
  previousHome = process.env.ABACUSAI_BOT_HOME;
  base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "rpc-checkpoints-"))
  );
  process.env.ABACUSAI_BOT_HOME = path.join(base, "app");
  project = path.join(base, "home", "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "a.txt"), "before\n");
  fs.writeFileSync(path.join(project, "b.txt"), "before\n");
  const connection = connectInProcess(fakeDeps());
  client = connection.client;
  close = () => {
    connection.closeClient();
    connection.closeServer();
  };
});

afterEach(() => {
  close();
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("checkpoints procedures", () => {
  it("list a session's turns with their files and counts", async () => {
    await recordTurn();
    const [turn] = await client.checkpoints.list({ sessionId: SESSION });
    expect(turn).toMatchObject({
      seq: 1,
      kind: "turn",
      messageId: "user-message-1",
      added: 2,
      removed: 2,
    });
    expect(turn?.files.map((file) => path.basename(file.path))).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  it("diff one file of a turn", async () => {
    await recordTurn();
    const [diff] = await client.checkpoints.diff({
      sessionId: SESSION,
      seq: 1,
      path: path.join(project, "a.txt"),
    });
    expect(diff).toMatchObject({ before: "before\n", after: "after\n" });
  });

  it("restore untouched files, report the one changed since, and force it", async () => {
    await recordTurn();
    fs.writeFileSync(path.join(project, "b.txt"), "user's own edit\n");

    const first = await client.checkpoints.restore({
      sessionId: SESSION,
      seq: 1,
    });
    expect(first.restored).toEqual([path.join(project, "a.txt")]);
    expect(first.conflicts).toEqual([path.join(project, "b.txt")]);
    expect(fs.readFileSync(path.join(project, "a.txt"), "utf8")).toBe(
      "before\n"
    );
    expect(fs.readFileSync(path.join(project, "b.txt"), "utf8")).toBe(
      "user's own edit\n"
    );

    const forced = await client.checkpoints.restore({
      sessionId: SESSION,
      seq: 1,
      paths: [path.join(project, "b.txt")],
      force: true,
    });
    expect(forced.restored).toEqual([path.join(project, "b.txt")]);
    expect(fs.readFileSync(path.join(project, "b.txt"), "utf8")).toBe(
      "before\n"
    );

    // The restore is its own entry, so the card can undo it.
    const turns = await client.checkpoints.list({ sessionId: SESSION });
    expect(turns.at(-1)).toMatchObject({ kind: "restore", of: 1 });
  });

  it("answer NOT_FOUND for a turn that was never recorded", async () => {
    await expect(
      client.checkpoints.diff({ sessionId: SESSION, seq: 9 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuse a restore while the agent is mid-turn", async () => {
    const tracker = await recordTurn();
    tracker.beginTurn("user-message-2");
    await tracker.capture([{ path: project, kind: "dir" }]);
    await expect(
      client.checkpoints.restore({ sessionId: SESSION, seq: 1 })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await tracker.settle();
  });
});
