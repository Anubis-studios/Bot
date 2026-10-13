import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let base = "";
vi.mock("../../profile-home", () => ({ profileBaseDir: () => base }));

const { clearSignInSession } = await import("./sign-in-session");

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "sign-in-session-"));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the leftover sign-in partition", () => {
  it("is removed with everything in it", async () => {
    const partition = path.join(base, "sign-in-session");
    fs.mkdirSync(path.join(partition, "Local Storage"), { recursive: true });
    fs.writeFileSync(path.join(partition, "Cookies"), "");

    await clearSignInSession();

    expect(fs.existsSync(partition)).toBe(false);
    expect(fs.existsSync(base)).toBe(true);
  });

  it("is a no-op when there is none", async () => {
    await expect(clearSignInSession()).resolves.toBeUndefined();
  });
});
