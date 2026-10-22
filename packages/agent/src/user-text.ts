import type { UserTextTags } from "./protocol.js";

const REMINDER_OPEN = "<system_reminder>";
const REMINDER_CLOSE = "</system_reminder>";
const ROUTINE_FIRE = /^\[routine\] "/;

/**
 * Removes each `<system_reminder>...</system_reminder>` block (shortest match,
 * left to right). A plain scan rather than a lazy regex, which goes quadratic
 * on many unclosed openers.
 */
const stripSystemReminders = (text: string): string => {
  let out = "";
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf(REMINDER_OPEN, pos);
    if (open < 0) break;
    const close = text.indexOf(REMINDER_CLOSE, open + REMINDER_OPEN.length);
    if (close < 0) break;
    out += text.slice(pos, open);
    pos = close + REMINDER_CLOSE.length;
  }
  return out + text.slice(pos);
};

export const hasSystemReminder = (text: string): boolean => {
  const open = text.indexOf(REMINDER_OPEN);
  return (
    open >= 0 && text.indexOf(REMINDER_CLOSE, open + REMINDER_OPEN.length) >= 0
  );
};

/** Old transcripts lack tags. Only the known, anchored envelopes are recognised. */
export const legacyOperator = (text: string): UserTextTags["operator"] => {
  if (text.startsWith("[first run] ")) return { kind: "kickstart" };
  if (text.startsWith("[mission updated] ")) return { kind: "mission-updated" };
  if (text.startsWith("[auto-reply] ")) {
    const boundary = text.indexOf("\n\n");
    return {
      kind: "auto-reply-intro",
      ...(boundary >= 0 && { visibleFrom: boundary + 2 }),
    };
  }
  return undefined;
};

export const isHiddenUserText = (
  text: string,
  tags?: UserTextTags
): boolean => {
  const operator = tags?.operator ?? legacyOperator(text);
  if (
    tags?.visibleFrom != null &&
    (!Number.isInteger(tags.visibleFrom) ||
      tags.visibleFrom < 0 ||
      tags.visibleFrom >= text.length)
  )
    return true;
  return (
    tags?.routineFire === true ||
    isRoutineFire(text) ||
    (operator != null &&
      (operator.visibleFrom == null ||
        !Number.isInteger(operator.visibleFrom) ||
        operator.visibleFrom < 0 ||
        operator.visibleFrom >= text.length))
  );
};

/** The user's own words, or "" when the message was entirely the app's. */
export const visibleUserText = (text: string, tags?: UserTextTags): string => {
  if (isHiddenUserText(text, tags)) return "";
  const operator = tags?.operator ?? legacyOperator(text);
  const boundary = tags?.visibleFrom ?? operator?.visibleFrom;
  const human =
    boundary != null && Number.isInteger(boundary) && boundary >= 0
      ? text.slice(boundary)
      : text;
  const withoutReminders = stripSystemReminders(human).trim();
  if (ROUTINE_FIRE.test(withoutReminders)) return "";
  return withoutReminders;
};

/** A routine firing: the message is hidden entirely in the old UI. */
export const isRoutineFire = (text: string): boolean =>
  ROUTINE_FIRE.test(stripSystemReminders(text).trim());
