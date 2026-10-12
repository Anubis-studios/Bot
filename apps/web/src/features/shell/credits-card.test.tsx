import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { UpgradePromo } from "./credits-card";
import { PromoOutlet } from "./promo-host";
import { openFloating, closeFloating } from "./shell-store";

const state = vi.hoisted(() => ({
  account: {
    user_id: "dummy",
    organization_id: "dummy-org",
    name: null,
    email: null,
    picture: null,
    organization: null,
    org_user_count: null,
    plan: null,
    subscription_tier: "free",
    credits_granted: 100,
    credits_used: 95,
  },
  exhaustedAt: null as number | null,
  refetch: vi.fn(),
  query: vi.fn(),
  open: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: unknown }) => {
    state.query(options);
    return {
      data: state.account,
      dataUpdatedAt: Date.now(),
      refetch: state.refetch,
    };
  },
}));
vi.mock("#renderer/data/db/prefs", () => ({
  usePrefs: () => ({ creditsExhaustedAt: state.exhaustedAt }),
  useUpdatePrefs: () => state.update,
}));
vi.mock("#renderer/lib/use-app-context", () => ({
  useAppContext: () => ({
    transport: {
      orpc: {
        account: {
          abacus: {
            queryOptions: () => ({ queryKey: ["account"] }),
            queryKey: () => ["account"],
          },
        },
      },
      client: { system: { openExternal: state.open } },
    },
  }),
}));
vi.mock("#renderer/lib/motion", async (original) => ({
  ...(await original<typeof import("#renderer/lib/motion")>()),
  useMotionPreference: () => "reduced",
}));
vi.mock("./promo-character", () => ({
  PromoCharacter: ({ excited }: { excited: boolean }) => (
    <span data-testid="character">{excited ? "excited" : "worried"}</span>
  ),
}));
// The card lives in the sidebar: render it with a pinned sidebar's outlet.
const promo = () => (
  <>
    <UpgradePromo />
    <PromoOutlet floating={false} />
  </>
);
beforeEach(async () => {
  await initI18n();
  localStorage.clear();
  state.exhaustedAt = null;
  state.query.mockClear();
  state.refetch.mockClear();
  state.refetch.mockResolvedValue({ data: state.account, isError: false });
  state.update.mockResolvedValue(undefined);
  state.account.subscription_tier = "free";
  state.account.user_id = "dummy";
  state.account.credits_used = 95;
});
it("shows actual credit progress and reacts to CTA focus", () => {
  render(promo());
  expect(screen.getByText("5 of 100 credits left")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "95"
  );
  fireEvent.focus(screen.getByRole("button", { name: "Upgrade" }));
  expect(screen.getByTestId("character").textContent).toBe("excited");
  expect(
    screen.queryByRole("button", { name: "Remind me in 10 minutes" })
  ).toBeNull();
});
it("points an account already on a paid tier at AbacusAI Agent on the web", async () => {
  state.account.subscription_tier = "pro";
  state.open.mockClear();
  render(promo());
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull()
  );
  expect(screen.getByText("Do even more on AbacusAI Agent")).toBeTruthy();
  expect(screen.getByText("5 of 100 credits left")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Go to AbacusAI Agent on the web" })
  );
  expect(state.open).toHaveBeenCalledWith({
    url: "https://apps.abacus.ai/chatllm",
  });
});

it("rounds floating point credit balances without changing progress", () => {
  state.account.credits_used = 95.36000000000001;
  render(promo());
  expect(screen.getByText("4.64 of 100 credits left")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "95.36000000000001"
  );
});

it("swaps the promo for the web card immediately on upgrade and restores it on downgrade", () => {
  const view = render(promo());
  state.account = { ...state.account, subscription_tier: "pro" };
  view.rerender(promo());
  expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Go to AbacusAI Agent on the web" })
  ).toBeTruthy();
  state.account = { ...state.account, subscription_tier: "free" };
  view.rerender(promo());
  expect(screen.getByRole("button", { name: "Upgrade" })).toBeTruthy();
});

it("hands one mounted mascot between pinned and peek sidebars, and hides it when collapsed", () => {
  const App = ({ mode }: { mode: "pinned" | "peek" | "collapsed" }) => (
    <>
      <UpgradePromo />
      {mode !== "collapsed" && <PromoOutlet floating={mode === "peek"} />}
    </>
  );
  const view = render(<App mode="pinned" />);
  const mascot = screen.getByTestId("character");
  fireEvent.focus(screen.getByRole("button", { name: "Upgrade" }));
  openFloating("peek");
  view.rerender(<App mode="peek" />);
  expect(screen.getByTestId("character")).toBe(mascot);
  expect(mascot.textContent).toBe("excited");
  closeFloating();
  view.rerender(<App mode="collapsed" />);
  expect(document.querySelector('[data-slot="upgrade-promo"]')).toBeNull();
  view.rerender(<App mode="pinned" />);
  expect(screen.getByRole("button", { name: "Upgrade" })).toBeTruthy();
});

it("keeps one account cache when an exhaustion notice is cleared", () => {
  const view = render(promo());
  state.exhaustedAt = Date.now();
  view.rerender(promo());
  expect(state.refetch).toHaveBeenCalledOnce();
  state.exhaustedAt = null;
  view.rerender(promo());
  for (const [options] of state.query.mock.calls)
    expect(options.queryKey).toEqual(["account"]);
});
