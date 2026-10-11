import type { BotRow } from "@abacus-ai/contract/contract/rows";
import type { TFunction } from "i18next";

import { BOT_TEMPLATES } from "#renderer/lib/bots/templates";

/**
 * A bot's line under its name: its title, unless the title only repeats the
 * name (most templates' do), then its template's one-line summary.
 */
export const botTagline = (
  bot: Pick<BotRow, "name" | "title">,
  t: TFunction
): string => {
  const title = bot.title.trim();
  if (title.toLocaleLowerCase() !== bot.name.trim().toLocaleLowerCase())
    return title;
  const template = BOT_TEMPLATES.find((row) => row.title === title);
  return template
    ? t(`bots.templates.${template.id}.description`, { defaultValue: "" })
    : "";
};
