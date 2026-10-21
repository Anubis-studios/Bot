import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { inertHostActions } from "../runtime/host-actions";
import { renderWithDb } from "../testing";
import { FeatureLimitNotice } from "./parts";
import { PaidFeatureCard } from "./tools/paid-feature";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
it.each([
  ["free", false, "Upgrade"],
  ["basic", true, "Upgrade"],
  ["paid", true, "Manage plan"],
  ["paid", false, null],
  ["basic", false, null],
  ["unknown", false, null],
] as const)(
  "feature limit uses eligible %s account action (%s)",
  async (tier, eligible, label) => {
    const openUpgrade = vi.fn(async () => {});
    const openExternal = vi.fn(async () => {});
    const accountTier = vi.fn(async () => tier);
    const rendered = await renderWithDb(
      <FeatureLimitNotice
        feature="Search"
        host={{
          ...inertHostActions,
          accountTier,
          canTopUpCredits: async () => eligible,
          openUpgrade,
          openExternal,
        }}
      />
    );
    cleanup = rendered.cleanup;
    if (label) {
      fireEvent.click(await screen.findByRole("button", { name: label }));
      expect(openUpgrade).toHaveBeenCalledOnce();
      expect(openExternal).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(accountTier).toHaveBeenCalled());
      expect(screen.queryByRole("button")).toBeNull();
    }
  }
);

it.each([
  [
    "video_gen",
    "Video Generation is included in Basic, in Abacus AI Agent on the web",
  ],
  ["image_gen", "Image Generation is included in Basic"],
] as const)(
  "names the paid-plan capability %s and upgrades a free account",
  async (feature, title) => {
    const openUpgrade = vi.fn(async () => {});
    const rendered = await renderWithDb(
      <PaidFeatureCard
        feature={feature}
        host={{ accountTier: async () => "free", openUpgrade }}
      />
    );
    cleanup = rendered.cleanup;
    expect(await screen.findByText(title)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade for $7" }));
    expect(openUpgrade).toHaveBeenCalledOnce();
  }
);

it.each(["basic", "paid", "unknown"] as const)(
  "shows a %s account no paid-plan upgrade",
  async (tier) => {
    const accountTier = vi.fn(async () => tier);
    const rendered = await renderWithDb(
      <PaidFeatureCard
        feature="video_gen"
        host={{ accountTier, openUpgrade: async () => {} }}
      />
    );
    cleanup = rendered.cleanup;
    await waitFor(() => expect(accountTier).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
  }
);
