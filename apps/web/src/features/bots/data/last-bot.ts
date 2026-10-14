/** The bot chat this profile last opened, where launch (`/`) lands. */
const KEY = "abacusai-bot:last-bot";

export const rememberBot = (botId: string): void => {
  try {
    localStorage.setItem(KEY, botId);
  } catch {
    // Full or blocked: launch opens the start page.
  }
};

export const lastBot = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
