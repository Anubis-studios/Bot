import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { expect, it, vi } from "vitest";

import { fixedT, initI18n } from "#renderer/lib/i18n";

import { ConnectStep } from "./connect";
import type { StepContext } from "./context";

it("retries the chosen sign-in and waits for cancellation before changing intent", async () => {
  await initI18n();
  let finishCancel!: () => void;
  const signIn = vi.fn(),
    navigate = vi.fn(async () => {});
  const cancelSignIn = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishCancel = resolve;
      })
  );
  const ctx = {
    props: {
      signIn,
      navigate,
      cancelSignIn,
    },
    t: fixedT(),
    busy: false,
    perform: async (action: () => Promise<unknown>) => {
      await action();
    },
    advance: vi.fn(),
    back: vi.fn(),
  } as unknown as StepContext;
  render(
    <ConnectStep
      ctx={ctx}
      attempt={{
        id: "attempt",
        intent: "signup",
        status: "failed",
        outcome: { ok: false, error: "offline" },
      }}
      heading={createRef()}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(signIn).toHaveBeenCalledWith("signup");
  signIn.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Sign in another way" }));
  expect(signIn).not.toHaveBeenCalled();
  finishCancel();
  await waitFor(() => expect(signIn).toHaveBeenCalledWith("signin"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(navigate).not.toHaveBeenCalled();
  finishCancel();
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("welcome"));
});
