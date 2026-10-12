import { describe, expect, it } from "vitest";

import { planOf } from "./selectors";
import type { ThreadStoreState } from "./thread-store";

describe("planOf", () => {
  it("reads state.agent.plan and is stable when absent", () => {
    const plan = [{ content: "a", status: "pending" as const }];
    expect(planOf({ agent: { plan } } as unknown as ThreadStoreState)).toBe(
      plan
    );
    expect(planOf({ agent: null } as unknown as ThreadStoreState)).toBe(
      planOf({ agent: {} } as unknown as ThreadStoreState)
    );
  });
});
