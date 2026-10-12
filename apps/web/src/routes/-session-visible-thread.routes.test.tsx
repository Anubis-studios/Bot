import { waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { visibleThreadStore } from "#renderer/lib/navigation/visible-thread";
import { renderApp } from "#renderer/test-support/app-harness";

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

it("the primary session route registers its thread as the visible one", async () => {
  app = await renderApp("/sessions/spreadsheet");
  await waitFor(() => expect(visibleThreadStore.state).toBe("spreadsheet"));
  app.view.unmount();
  await waitFor(() => expect(visibleThreadStore.state).toBeNull());
});
