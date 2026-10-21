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
  [
    "image_gen",
    "Image Generation is included in Basic, in Abacus AI Agent on the web",
  ],
  ["video", "Video Analysis is included in Basic"],
] as const)(
  "names the paid-plan capability %s and upgrades a free account",
  async (feature, title) => {
    const openUpgrade = vi.fn(async () => {});
    const openExternal = vi.fn(async () => {});
    const rendered = await renderWithDb(
      <PaidFeatureCard
        feature={feature}
        host={{ accountTier: async () => "free", openUpgrade, openExternal }}
      />
    );
    cleanup = rendered.cleanup;
    expect(await screen.findByText(title)).toBeTruthy();
    expect(
      screen.queryByText(
        "Basic includes creating and editing images and videos, and making audio, on the web in Abacus AI Agent."
      ) != null
    ).toBe(feature !== "video");
    fireEvent.click(screen.getByRole("button", { name: "Upgrade for $7" }));
    expect(openUpgrade).toHaveBeenCalledOnce();
    expect(openExternal).not.toHaveBeenCalled();
  }
);

it.each(["basic", "paid"] as const)(
  "sends a %s account to Abacus AI Agent with the request filled in, never an upgrade",
  async (tier) => {
    const openUpgrade = vi.fn(async () => {});
    const openExternal = vi.fn(async () => {});
    const rendered = await renderWithDb(
      <PaidFeatureCard
        feature="image_gen"
        prompt="a fox in the snow"
        host={{ accountTier: async () => tier, openUpgrade, openExternal }}
      />
    );
    cleanup = rendered.cleanup;
    expect(
      await screen.findByText(
        "Image Generation is in Abacus AI Agent on the web"
      )
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Open in Abacus AI Agent" })
    );
    expect(openExternal).toHaveBeenCalledWith(
      "https://apps.abacus.ai/chatllm/agent?prompt=a+fox+in+the+snow"
    );
    expect(openUpgrade).not.toHaveBeenCalled();
  }
);

it.each([
  ["basic", "video"],
  ["paid", "video"],
  ["unknown", "video_gen"],
] as const)("shows a %s account no card for %s", async (tier, feature) => {
  const accountTier = vi.fn(async () => tier);
  const rendered = await renderWithDb(
    <PaidFeatureCard
      feature={feature}
      host={{
        accountTier,
        openUpgrade: async () => {},
        openExternal: async () => {},
      }}
    />
  );
  cleanup = rendered.cleanup;
  await waitFor(() => expect(accountTier).toHaveBeenCalled());
  expect(screen.queryByRole("button")).toBeNull();
});
