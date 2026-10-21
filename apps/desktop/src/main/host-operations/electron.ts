import { app } from "electron";

import type { HostPlatformOperations } from "../handler";
import { registerLoginItem } from "../login-item";
import {
  cancelAbacusAuth,
  startAbacusAuth,
} from "../services/providers/abacus-auth-service";
import { shouldAutoSignIn } from "../services/providers/abacus-signin-config";
import {
  cancelOpenRouterAuth,
  startOpenRouterAuth,
} from "../services/providers/openrouter-auth-service";
import { clearSignInSession } from "../services/providers/sign-in-session";
import { requestMicrophoneAccess } from "../services/voice/microphone";

export const electronHostPlatform: HostPlatformOperations = {
  startAbacusAuth,
  startOpenRouterAuth,
  cancelAbacusAuth,
  shouldAutoSignIn,
  cancelOpenRouterAuth,
  clearSignInSession,
  registerLoginItem,
  requestMicrophoneAccess,
  relaunch: () => {
    app.relaunch();
    app.quit();
  },
};
