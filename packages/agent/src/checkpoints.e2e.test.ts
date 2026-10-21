/**
 * The built host, end to end: a turn whose only edit is a real shell command
 * in a folder outside the workspace (no git anywhere) is recorded under the
 * message that asked, and restoring it puts the bytes back.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FakeProvider,
  fakeProviderConfig,
} from "@abacus-ai/test-support/fake-provider";
import { afterAll, beforeAll, expect, it } from "vitest";

import { checkpointsDirFor, CheckpointStore } from "./checkpoint-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.resolve(HERE, "..", "dist", "main.js");
const SESSION = "checkpoints-e2e";
const ORIGINAL = "print('working')\n";

let provider: FakeProvider;
let base: string;

beforeAll(async () => {
  process.env.PI_OFFLINE = "1";
  provider = await FakeProvider.start();
  base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-checkpoints-e2e-"))
  );
  fs.mkdirSync(path.join(base, "home"));
  fs.writeFileSync(
    path.join(base, "home", "config.json"),
    fakeProviderConfig(provider)
  );
}, 180_000);

afterAll(async () => {
  await provider?.close();
  try {
    fs.rmSync(base, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 300,
    });
  } catch {
    // Left for the OS to clean up.
  }
});

it("records a shell edit outside the workspace and restores it byte for byte", async () => {
  const workspace = path.join(base, "workspace");
  const site = path.join(base, "elsewhere", "site");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, "app.py"), ORIGINAL);

  provider.script((call) =>
    call.messages.at(-1)?.role === "user"
      ? {
          call: {
            name: "bash",
            args: {
              command: `cd "${site.replaceAll("\\", "/")}" && sed -i 's/working/broken/' app.py`,
            },
          },
        }
      : { say: "Done." }
  );

  const store = new CheckpointStore(checkpointsDirFor(path.join(base, "home")));
  await new Promise<void>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        HOST,
        "--thread-id",
        SESSION,
        "--compat-fd",
        "-1",
        "--permission-mode",
        "YOLO",
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          ABACUSAI_BOT_HOME: path.join(base, "home"),
          ABACUSAI_BOT_SESSION_ID: SESSION,
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    const done = (): void => {
      clearInterval(poll);
      child.stdin.end();
      child.kill();
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    // The record lands when the run settles, just after the turn's last event.
    const poll = setInterval(() => {
      void store.listTurns(SESSION).then((turns) => {
        if (turns.length > 0) done();
      });
    }, 200);
    const timer = setTimeout(done, 60_000);
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", () => undefined);
    child.stdin.write(
      `${JSON.stringify({ type: "send", message: "break it", messageId: "m1" })}\n`
    );
    child.on("exit", () => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    });
  });

  expect(fs.readFileSync(path.join(site, "app.py"), "utf8")).toBe(
    "print('broken')\n"
  );
  const [turn] = await store.listTurns(SESSION);
  expect(turn?.messageId).toBe("m1");
  expect(turn?.files.map((file) => path.basename(file.path))).toEqual([
    "app.py",
  ]);

  const result = await store.restore(SESSION, turn!.seq);
  expect(result.restored).toHaveLength(1);
  expect(fs.readFileSync(path.join(site, "app.py"), "utf8")).toBe(ORIGINAL);
}, 120_000);
