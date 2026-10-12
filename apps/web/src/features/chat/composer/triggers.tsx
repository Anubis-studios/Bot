/**
 * The composer's `@` (file mentions, sessions) and `/` (skills, at the
 * start of the field) menus (spec 02 §8.4). The menu owns the keyboard
 * while open: arrows move, Enter/Tab pick, Escape closes.
 */
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import { Spinner } from "#renderer/ui/spinner";

import type { MentionSource } from "../kit/context";
import type { SkillMetadata } from "../store/thread-store";

export interface TriggerState {
  kind: "mention" | "skill";
  query: string;
  /** The token's range in the text, replaced on pick. */
  start: number;
  end: number;
}

export const triggerAt = (
  text: string,
  caret: number,
  enabled: { mentions: boolean; skills: boolean }
): TriggerState | null => {
  const before = text.slice(0, caret);
  if (enabled.skills) {
    const skill = /^\/([\w-]*)$/.exec(before);
    if (skill != null)
      return { kind: "skill", query: skill[1]!, start: 0, end: caret };
  }
  if (enabled.mentions) {
    const mention = /(^|\s)@([\w./-]*)$/.exec(before);
    if (mention != null)
      return {
        kind: "mention",
        query: mention[2]!,
        start: caret - mention[2]!.length - 1,
        end: caret,
      };
  }
  return null;
};

export const TriggerMenu = ({
  trigger,
  skills,
  mentions,
  onPick,
  onClose,
  field,
}: {
  trigger: TriggerState;
  skills: readonly SkillMetadata[];
  mentions: MentionSource | undefined;
  onPick(insert: string): void;
  onClose(): void;
  field: RefObject<HTMLTextAreaElement | null>;
}) => {
  const { t } = useTranslation();
  const [result, setResult] = useState<{
    query: string;
    files: string[];
  } | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (trigger.kind !== "mention" || mentions == null) return;
    let live = true;
    const settle = (files: string[]) => {
      if (!live) return;
      setResult({ query: trigger.query, files });
      setActive(0);
    };
    mentions
      .search(trigger.query)
      .then((found) => settle(found.slice(0, 8)))
      .catch(() => settle([]));
    return () => {
      live = false;
    };
  }, [trigger.kind, trigger.query, mentions]);
  const files = result?.files ?? [];
  const loading =
    trigger.kind === "mention" &&
    mentions != null &&
    result?.query !== trigger.query;
  const options =
    trigger.kind === "skill"
      ? skills
          .filter((skill) =>
            skill.name.toLowerCase().includes(trigger.query.toLowerCase())
          )
          .slice(0, 8)
          .map((skill) => ({
            id: skill.id,
            label: `/${skill.name}`,
            hint: skill.description,
            insert: `/${skill.name} `,
          }))
      : files.map((path) => ({
          id: path,
          label: path,
          hint: "",
          insert: `@${path} `,
        }));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.target !== field.current ||
        options.length === 0
      )
        return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive(
          (index) =>
            (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) %
            options.length
        );
      } else if (
        (event.key === "Enter" || event.key === "Tab") &&
        !(event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onPick(options[Math.min(active, options.length - 1)]!.insert);
      } else if (event.key === "Escape") {
        onClose();
      }
    };
    const element = field.current;
    element?.addEventListener("keydown", onKey, true);
    return () => element?.removeEventListener("keydown", onKey, true);
  }, [options, active, onPick, onClose, field]);
  const showing = options.length > 0 || (trigger.kind === "mention" && loading);
  const activeId = options.length > 0 ? `${listId}-${active}` : undefined;
  useEffect(() => {
    const element = field.current;
    if (element == null || !showing) return;
    element.setAttribute("role", "combobox");
    element.setAttribute("aria-expanded", "true");
    element.setAttribute("aria-controls", listId);
    element.setAttribute("aria-autocomplete", "list");
    if (activeId != null)
      element.setAttribute("aria-activedescendant", activeId);
    else element.removeAttribute("aria-activedescendant");
    return () => {
      for (const name of [
        "role",
        "aria-expanded",
        "aria-controls",
        "aria-autocomplete",
        "aria-activedescendant",
      ])
        element.removeAttribute(name);
    };
  }, [showing, activeId, listId, field]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[id="${listId}-${active}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId, options.length]);
  if (!showing) return null;
  return (
    <div
      ref={list}
      id={listId}
      role="listbox"
      aria-label={
        trigger.kind === "skill"
          ? t("chat.composer.skills")
          : t("chat.composer.files")
      }
      className={cn(
        "mb-1.5 flex flex-col rounded-[14px] bg-[var(--chat-surface)] p-1.5",
        trigger.kind === "mention" && "chat-mono text-xs"
      )}
    >
      {options.map((option, index) => (
        <button
          key={option.id}
          id={`${listId}-${index}`}
          type="button"
          role="option"
          aria-selected={index === active}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(option.insert)}
          className={cn(
            "flex h-8 items-center gap-2 rounded-lg px-2.5 text-start",
            index === active && "bg-secondary"
          )}
        >
          <span className="truncate">{option.label}</span>
          {option.hint !== "" ? (
            <span className="text-muted-foreground truncate text-xs">
              {option.hint}
            </span>
          ) : null}
        </button>
      ))}
      {loading && trigger.kind === "mention" ? (
        <div
          role="status"
          className="text-muted-foreground flex h-8 items-center gap-2 px-2.5 text-xs"
        >
          <Spinner aria-hidden />
          <span>{t("common.loading")}</span>
        </div>
      ) : null}
    </div>
  );
};
