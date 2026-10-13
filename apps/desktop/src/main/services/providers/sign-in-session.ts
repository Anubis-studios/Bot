/**
 * The browser partition an earlier release signed in with, beside the profile
 * registry. Nothing opens it any more, but it can still hold an Abacus.AI
 * session and provider logins, so sign-out and every sign-in remove it.
 */
import fs from "fs";
import path from "path";

import { profileBaseDir } from "../../profile-home";

export const clearSignInSession = async (): Promise<void> => {
  await fs.promises.rm(path.join(profileBaseDir(), "sign-in-session"), {
    recursive: true,
    force: true,
  });
};
