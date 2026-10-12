/**
 * Codex r1 #16 / Claude r1 #33 (spec 02 §9.1): the chat's CSS motion follows
 * the app's preference the way the foundation resolves it: `prefs.motion.
 * reduce` is `data-reduce-motion` on <html> ("on" | "off" | "system"), "on"
 * reduces with the OS setting off, "off" keeps full motion with it on.
 *
 * jsdom has no media queries, so the cascade is evaluated here: the sheet is
 * parsed by the DOM, every rule whose selector matches applies in source
 * order, and a `prefers-reduced-motion: reduce` block applies only when the
 * OS setting is simulated on.
 */
import { afterEach, describe, expect, it } from "vitest";

// Read from disk: the project's CSS pipeline passes only tokens.css through
// (`?raw` of chat.css is empty), and renderer has no Node types.
const nodeFs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: "node:fs"): unknown };
  }
).process.getBuiltinModule("node:fs") as {
  readFileSync(path: string, encoding: "utf8"): string;
};
const css = nodeFs.readFileSync(
  `${(import.meta as ImportMeta & { dirname: string }).dirname}/chat.css`,
  "utf8"
);

type Pref = "on" | "off" | "system";

const declared = (element: Element, os: boolean, property: string): string => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  let value = "";
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule) {
        if (/prefers-reduced-motion:\s*reduce/.test(rule.media.mediaText)) {
          if (os) visit(rule.cssRules);
        } else visit(rule.cssRules);
        continue;
      }
      if (!(rule instanceof CSSStyleRule)) continue;
      let matches = false;
      try {
        matches = element.matches(rule.selectorText);
      } catch {
        matches = false;
      }
      if (!matches) continue;
      const next = rule.style.getPropertyValue(property);
      if (next !== "") value = next;
    }
  };
  visit(style.sheet!.cssRules);
  style.remove();
  return value;
};

const mount = (pref: Pref) => {
  document.documentElement.dataset.reduceMotion = pref;
  document.body.innerHTML = `
    <span class="chat-typing-dot"></span>
    <span class="shimmer">Thinking</span>
    <div data-slot="message-scroller-item" data-fresh></div>
    <div class="chat-prose chat-prose-streaming"><p>a</p><p id="last">b</p></div>`;
  return {
    dot: document.querySelector(".chat-typing-dot")!,
    shimmer: document.querySelector(".shimmer")!,
    fresh: document.querySelector("[data-fresh]")!,
    last: document.querySelector("#last")!,
  };
};

afterEach(() => {
  delete document.documentElement.dataset.reduceMotion;
  document.body.innerHTML = "";
});

const reduced = (pref: Pref, os: boolean): boolean => {
  const { dot, shimmer, fresh, last } = mount(pref);
  const states = [
    declared(dot, os, "animation") === "none",
    declared(shimmer, os, "animation") === "none" &&
      declared(shimmer, os, "--shimmer-image") === "none",
    declared(fresh, os, "translate") === "none",
    declared(last, os, "animation") === "none",
  ];
  // Every element agrees: all reduced or none.
  expect(new Set(states).size, `${pref}/${os}: ${states}`).toBe(1);
  return states[0]!;
};

describe("chat CSS reduced motion", () => {
  it("follows the OS when the preference is system", () => {
    expect(reduced("system", false)).toBe(false);
    expect(reduced("system", true)).toBe(true);
  });

  it("the in-app 'on' reduces with the OS setting off", () => {
    expect(reduced("on", false)).toBe(true);
    expect(reduced("on", true)).toBe(true);
  });

  it("the in-app 'off' keeps full motion with the OS setting on", () => {
    expect(reduced("off", true)).toBe(false);
    expect(reduced("off", false)).toBe(false);
  });

  it("diff colours target the highlighter's classes", () => {
    expect(css).toMatch(/\.th-inserted/);
    expect(css).toMatch(/\.th-deleted/);
    expect(css).not.toMatch(/\.token\.(inserted|deleted)/);
    expect(css).not.toMatch(/data-motion=/);
  });
});

// The scale is the :root tokens; resolve var(--chat-space-N) from them.
const scale = (value: string) =>
  value.replace(/var\(--chat-space-(\d+)\)/g, (_, n: string) => {
    const token = new RegExp(`--chat-space-${n}:\\s*(\\d+px)`).exec(css);
    return token?.[1] ?? value;
  });

describe("tool cluster geometry", () => {
  it("keeps consecutive calls tight and separates other rows", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    try {
      document.body.innerHTML = `<div data-slot="message-scroller-content">
        <div data-tool-only></div>
        <div id="same" data-tool-only data-tool-gap="same"></div>
        <div id="different" data-tool-only data-tool-gap="different"></div>
        <div id="text"></div>
        <div id="after-text" data-tool-gap="same"></div>
      </div><div id="cluster" data-slot="tool-cluster"></div>`;
      expect(
        scale(getComputedStyle(document.querySelector("#same")!).paddingTop)
      ).toBe("2px");
      expect(
        scale(
          getComputedStyle(document.querySelector("#different")!).paddingTop
        )
      ).toBe("8px");
      expect(
        scale(getComputedStyle(document.querySelector("#text")!).paddingTop)
      ).toBe("12px");
      expect(
        scale(
          getComputedStyle(document.querySelector("#after-text")!).paddingTop
        )
      ).toBe("12px");
      expect(getComputedStyle(document.querySelector("#cluster")!).gap).toBe(
        "2px"
      );
    } finally {
      style.remove();
    }
  });
  it("steps the sessions transcript on one scale, one owner per boundary", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    document.body.innerHTML = `
      <div data-skin="session"><div data-slot="message-scroller-content">
        <div id="u1" data-turn="user"></div>
        <div id="a1" data-turn="assistant">
          <div data-slot="assistant-parts">
            <p id="prose" class="chat-prose"></p><div id="group" data-slot="tool-group"></div><p id="after" class="chat-prose"></p><div id="card" data-slot="deliverables-card"></div><div id="actions" data-slot="turn-actions"></div>
          </div>
        </div>
        <div id="marker" data-outcome></div>
        <div id="a2" data-turn="assistant"></div>
        <div id="day" data-slot="day-separator"></div>
        <div id="u2" data-turn="user"></div>
        <div id="day2" data-slot="day-separator"></div>
        <div id="a3" data-turn="assistant"></div>
        <div id="busy" data-slot="busy-line"></div>
        <div id="u3" data-turn="user"></div>
        <div id="busy2" data-slot="busy-line"></div>
        <div id="error"></div>
      </div></div>`;
    try {
      const pad = (id: string) =>
        scale(getComputedStyle(document.querySelector(id)!).paddingTop);
      const margin = (id: string) =>
        scale(getComputedStyle(document.querySelector(id)!).marginTop);
      // Turn boundaries: 24 around a user message, 12 between replies.
      expect(pad("#a1")).toBe("24px");
      expect(pad("#a2")).toBe("12px");
      expect(pad("#u2")).toBe("16px"); // after a day separator
      expect(pad("#a3")).toBe("16px");
      // Day separator: 16 above and below, 24 after a user message.
      expect(pad("#day")).toBe("16px");
      expect(pad("#day2")).toBe("24px");
      // Live row and run marker hug what is above; after a user message they
      // keep the turn gap.
      expect(pad("#marker")).toBe("4px");
      expect(pad("#busy")).toBe("4px");
      expect(pad("#busy2")).toBe("24px");
      expect(pad("#error")).toBe("12px");
      expect(pad("#u3")).toBe("24px");
      // Within a turn: prose and group hug both ways; other parts 4 / 8;
      // the footer is a 12 card then a 4 actions row.
      expect(margin("#group")).toBe("0px");
      expect(margin("#after")).toBe("0px");
      expect(margin("#card")).toBe("12px");
      expect(margin("#actions")).toBe("4px");
    } finally {
      style.remove();
      document.body.innerHTML = "";
    }
  });
});
