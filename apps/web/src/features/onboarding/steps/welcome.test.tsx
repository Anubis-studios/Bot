import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { expect, it, vi } from "vitest";

import { fixedT, initI18n } from "#renderer/lib/i18n";

import type { StepContext } from "./context";
import { WelcomeStep } from "./welcome";

it("starts signup or a direct sign-in", async () => {
  await initI18n();
  const signIn = vi.fn();
  const ctx = {
    t: fixedT(),
    busy: false,
    props: { signIn },
  } as unknown as StepContext;
  render(<WelcomeStep ctx={ctx} heading={createRef()} />);
  fireEvent.click(screen.getByRole("button", { name: "Sign up for free" }));
  expect(signIn).toHaveBeenLastCalledWith("signup");
  fireEvent.click(
    screen.getByRole("button", { name: "I already have an account" })
  );
  expect(signIn).toHaveBeenLastCalledWith("signin");
});
