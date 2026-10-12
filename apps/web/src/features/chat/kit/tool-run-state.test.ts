import { afterEach, describe, expect, it } from "vitest";

import { isRunOpen, resetRunState, setRunOpen } from "./tool-run-state";

afterEach(resetRunState);

describe("tool run disclosure", () => {
  it("defaults closed and is kept per thread and run", () => {
    expect(isRunOpen("t1", "c1")).toBe(false);
    setRunOpen("t1", "c1", true);
    expect(isRunOpen("t1", "c1")).toBe(true);
    expect(isRunOpen("t2", "c1")).toBe(false);
    setRunOpen("t1", "c1", false);
    expect(isRunOpen("t1", "c1")).toBe(false);
  });
});
