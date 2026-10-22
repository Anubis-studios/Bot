import { BOT_HELP_TOOL } from "@abacus-ai/contract/bot-help";

import { BOT_HELP_INPUT_SCHEMA, BOT_HELP_PHONE_DESCRIPTION } from "../bot-help";
import type { PhoneToolDefinition } from "./definition";

/** `bot_help` on the phone: the same answer, with its places as steps. */
export const PHONE_BOT_HELP_TOOLS: PhoneToolDefinition[] = [
  {
    surface: "phone",
    name: BOT_HELP_TOOL,
    toolsets: "always",
    description: BOT_HELP_PHONE_DESCRIPTION,
    inputSchema: BOT_HELP_INPUT_SCHEMA,
    run: (host, args, callerSession) => host.botHelp(args, callerSession),
  },
];
