import { useRouter } from "@tanstack/react-router";

import { useDb } from "#renderer/data/db";
import type { OnboardingStepId } from "#renderer/lib/navigation/areas";

import { OnboardingFrame, OnboardingStepPage } from "./index";
export const OnboardingGallery = ({ step }: { step: OnboardingStepId }) => {
  const router = useRouter();
  const { transport } = router.options.context;
  const db = useDb();
  const bot = db.collections.bots.toArray[0];
  const previewBot = bot
    ? { bot, checkInRoutineId: "fixture-weekday-check-in" }
    : undefined;
  return (
    <OnboardingFrame step={step} previewBot={previewBot}>
      <OnboardingStepPage
        step={step}
        transport={transport}
        facts={{
          signedIn: step !== "welcome" && step !== "connect",
          payingTier: false,
          ownsBot: false,
        }}
        preview={true}
        previewBot={previewBot}
        navigate={async () => {}}
        signIn={() => {}}
        cancelSignIn={async () => {}}
        complete={async () => {}}
        createFirstBot={async () => {
          throw new Error("Gallery does not create bots");
        }}
      />
    </OnboardingFrame>
  );
};
