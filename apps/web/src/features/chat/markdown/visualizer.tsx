/**
 * A ```visualizer fenced block: agent-written HTML/SVG/JS (a chart, a diagram,
 * a small widget) shown in a sandboxed iframe. The sandbox grants scripts only,
 * never `allow-same-origin`, so the guest has an opaque origin: no access to the
 * app's cookies, storage or DOM. A CSP also cuts every network channel but
 * script/style CDNs. The guest reports its height, link clicks and
 * `sendPrompt()` over `postMessage`; the host decides what each does.
 */
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Skeleton } from "#renderer/ui/skeleton";

const DEFAULT_HEIGHT = 200;
const MAX_HEIGHT = 4000;

const DARK_VARS = `
  --color-text-primary: #E5E7EB; --color-text-secondary: #9CA3AF; --color-text-tertiary: #6B7280;
  --color-text-info: #60A5FA; --color-text-success: #34D399; --color-text-warning: #FBBF24; --color-text-danger: #F87171;
  --color-background-primary: #1A1A1A; --color-background-secondary: #262626; --color-background-tertiary: #111111;
  --color-border-tertiary: rgba(255,255,255,0.15); --color-border-secondary: rgba(255,255,255,0.3);
  --ramp-purple-bg: #3C3489; --ramp-purple-stroke: #AFA9EC; --ramp-purple-text: #CECBF6; --ramp-purple-sub: #AFA9EC;
  --ramp-teal-bg: #085041; --ramp-teal-stroke: #5DCAA5; --ramp-teal-text: #9FE1CB; --ramp-teal-sub: #5DCAA5;
  --ramp-coral-bg: #712B13; --ramp-coral-stroke: #F0997B; --ramp-coral-text: #F5C4B3; --ramp-coral-sub: #F0997B;
  --ramp-gray-bg: #444441; --ramp-gray-stroke: #B4B2A9; --ramp-gray-text: #D3D1C7; --ramp-gray-sub: #B4B2A9;
  --ramp-blue-bg: #0C447C; --ramp-blue-stroke: #85B7EB; --ramp-blue-text: #B5D4F4; --ramp-blue-sub: #85B7EB;
  --ramp-amber-bg: #633806; --ramp-amber-stroke: #EF9F27; --ramp-amber-text: #FAC775; --ramp-amber-sub: #EF9F27;
`;

const LIGHT_VARS = `
  --color-text-primary: #1F2937; --color-text-secondary: #6B7280; --color-text-tertiary: #9CA3AF;
  --color-text-info: #2563EB; --color-text-success: #059669; --color-text-warning: #D97706; --color-text-danger: #DC2626;
  --color-background-primary: #FFFFFF; --color-background-secondary: #F9FAFB; --color-background-tertiary: #F3F4F6;
  --color-border-tertiary: rgba(0,0,0,0.15); --color-border-secondary: rgba(0,0,0,0.3);
  --ramp-purple-bg: #EEEDFE; --ramp-purple-stroke: #534AB7; --ramp-purple-text: #3C3489; --ramp-purple-sub: #534AB7;
  --ramp-teal-bg: #E1F5EE; --ramp-teal-stroke: #0F6E56; --ramp-teal-text: #085041; --ramp-teal-sub: #0F6E56;
  --ramp-coral-bg: #FAECE7; --ramp-coral-stroke: #993C1D; --ramp-coral-text: #712B13; --ramp-coral-sub: #993C1D;
  --ramp-gray-bg: #F1EFE8; --ramp-gray-stroke: #5F5E5A; --ramp-gray-text: #444441; --ramp-gray-sub: #5F5E5A;
  --ramp-blue-bg: #E6F1FB; --ramp-blue-stroke: #185FA5; --ramp-blue-text: #0C447C; --ramp-blue-sub: #185FA5;
  --ramp-amber-bg: #FAEEDA; --ramp-amber-stroke: #854F0B; --ramp-amber-text: #633806; --ramp-amber-sub: #854F0B;
`;

const STYLES = (vars: string): string => `
:root { ${vars}
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: "SF Mono", Menlo, monospace;
  --border-radius-md: 8px; --border-radius-lg: 12px; }
* { box-sizing: border-box; margin: 0; font-family: var(--font-sans); }
html, body { overflow: hidden; min-height: 0 !important; height: auto !important; background: transparent !important; }
body { color: var(--color-text-primary); line-height: 1.5; }
button { background: transparent; border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-md); padding: 6px 14px; font-size: 13px; color: var(--color-text-primary); cursor: pointer; }
button:hover { background: var(--color-background-secondary); }
select { appearance: none; background: var(--color-background-secondary); border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-md); padding: 6px 10px; font-size: 13px; color: var(--color-text-primary); }
.t { font: 400 14px var(--font-sans); fill: var(--color-text-primary); }
.ts { font: 400 12px var(--font-sans); fill: var(--color-text-secondary); }
.th { font: 500 14px var(--font-sans); fill: var(--color-text-primary); }
.box { fill: var(--color-background-secondary); stroke: var(--color-border-tertiary); }
.node { cursor: pointer; } .node:hover { opacity: 0.85; }
.arr { stroke: var(--color-border-secondary); stroke-width: 1.5; fill: none; }
.leader { stroke: var(--color-text-tertiary); stroke-width: 0.5; stroke-dasharray: 3 2; fill: none; }
canvas { max-width: 100%; } img { max-width: 100%; height: auto; }
`;

/**
 * The guest may run its own scripts and load chart libraries over https, but
 * cannot fetch, post, frame or navigate anywhere with its data.
 */
export const VISUALIZER_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob:",
  "font-src data: https:",
  "media-src data: blob:",
  "worker-src blob:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join("; ");

const bridge = (channel: string): string => `<script>
(function () {
  var C = ${JSON.stringify(channel)};
  var post = function (m) { m.channel = C; try { parent.postMessage(m, '*'); } catch (e) {} };
  window.onerror = function () { return true; };
  window.sendPrompt = function (text) {
    if (typeof text === 'string' && text) post({ type: 'prompt', text: text });
  };
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t.tagName !== 'A') t = t.parentElement;
    if (!t) return;
    var href = t.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;
    e.preventDefault();
    post({ type: 'link', href: t.href || href });
  }, true);
  var last = 0;
  var measure = function () {
    var h = Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight);
    if (h > 0 && h !== last) { last = h; post({ type: 'height', height: h }); }
  };
  addEventListener('load', measure);
  document.addEventListener('DOMContentLoaded', function () {
    measure();
    if (window.ResizeObserver) new ResizeObserver(measure).observe(document.body);
  });
  setInterval(measure, 500);
})();
</script>`;

/** The full guest document for `code` in one theme. */
export const buildVisualizerDocument = (
  code: string,
  dark: boolean,
  channel: string
): string =>
  `<!DOCTYPE html><html style="background:transparent"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VISUALIZER_CSP}"><style>${STYLES(dark ? DARK_VARS : LIGHT_VARS)}</style>${bridge(channel)}</head><body>${code.replace(/​/g, "")}</body></html>`;

/** Heights by source, so a remount does not grow the block from the default. */
const heightCache = new Map<string, number>();

const useIsDark = (): boolean => {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark"))
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return dark;
};

export interface VisualizerProps {
  code: string;
  /** Still streaming: the source is incomplete, so draw a placeholder. */
  streaming?: boolean;
  onOpenLink?: (url: string) => void;
  onPrompt?: (text: string) => void;
}

export const Visualizer = ({
  code,
  streaming = false,
  onOpenLink,
  onPrompt,
}: VisualizerProps) => {
  const { t } = useTranslation();
  const dark = useIsDark();
  const channel = useId();
  const frame = useRef<HTMLIFrameElement>(null);
  const cached = heightCache.get(code);
  const [height, setHeight] = useState(cached ?? DEFAULT_HEIGHT);
  const [loaded, setLoaded] = useState(cached !== undefined);
  const doc = streaming ? "" : buildVisualizerDocument(code, dark, channel);
  const openLink = useEffectEvent((href: string) => onOpenLink?.(href));
  const prompt = useEffectEvent((text: string) => onPrompt?.(text));
  const remember = useEffectEvent((next: number) => {
    heightCache.set(code, next);
  });

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as {
        channel?: unknown;
        type?: unknown;
        [key: string]: unknown;
      } | null;
      if (data == null || data.channel !== channel) return;
      if (data.type === "height" && typeof data.height === "number") {
        const next = Math.min(MAX_HEIGHT, Math.ceil(data.height));
        remember(next);
        setHeight(next);
        setLoaded(true);
      } else if (data.type === "link" && typeof data.href === "string") {
        // Only web links leave the sandbox; anything else is dropped.
        if (/^https?:\/\//i.test(data.href)) openLink(data.href);
      } else if (data.type === "prompt" && typeof data.text === "string") {
        prompt(data.text);
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [channel]);

  return (
    <div
      className="chat-visualizer border-border bg-secondary my-2 overflow-hidden rounded-lg border p-3"
      data-slot="visualizer"
    >
      <div className="relative" style={{ height }}>
        {streaming ? null : (
          <iframe
            ref={frame}
            title={t("chat.visualizer.title")}
            // Scripts only: no same-origin, popups, forms or top navigation.
            sandbox="allow-scripts"
            srcDoc={doc}
            referrerPolicy="no-referrer"
            className="block size-full border-0 transition-opacity duration-300"
            style={{ opacity: loaded ? 1 : 0 }}
          />
        )}
        {loaded && !streaming ? null : (
          <Skeleton
            className="pointer-events-none absolute inset-0"
            aria-label={t("chat.visualizer.drawing")}
          />
        )}
      </div>
    </div>
  );
};
