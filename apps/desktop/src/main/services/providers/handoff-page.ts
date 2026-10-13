/**
 * The page a browser tab shows when a sign-in hands back to the app: Abacus.AI,
 * OpenRouter, and MCP and hosted connector sign-ins. It is the light hand-off
 * screen the website's bot pages use (connect, vault, upgrade), so every one
 * of these tabs looks the same whatever the system theme.
 */

// The app icon as the AbacusAI Bot site serves it.
const BOT_LOGO_URL = "https://abacus.ai/static/imgs/abacusbot/bot-logo.webp";

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ] ?? ch
  );

export interface HandoffPageOptions {
  /** Plain text; escaped here. */
  title: string;
  /** Plain text; escaped here. */
  body: string;
  /** The badge on the logo: a green check, or an amber mark for a failure. */
  tone?: "ok" | "warn";
  /** Trusted inline script. The page's ids (`title`, `body`, `badge`, `badge-ok`, `badge-warn`) are stable for it. */
  script?: string;
}

export const handoffPage = ({
  title,
  body,
  tone = "ok",
  script = "",
}: HandoffPageOptions): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AbacusAI Bot</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 48px 24px; box-sizing: border-box;
    font: 16px/1.5 Inter, ui-sans-serif, -apple-system, system-ui, sans-serif;
    background: #fff; color: #0a0a0a;
  }
  .card { width: 100%; max-width: 384px; display: flex; flex-direction: column; align-items: center; text-align: center; }
  .mark { position: relative; width: 64px; height: 64px; }
  .logo { display: block; width: 64px; height: 64px; border-radius: 16px; }
  .badge {
    position: absolute; right: -4px; bottom: -4px; width: 28px; height: 28px; box-sizing: border-box;
    border-radius: 999px; border: 3px solid #fff; background: #16a34a;
    display: flex; align-items: center; justify-content: center;
  }
  .badge.warn { background: #f59e0b; }
  h1 { margin: 32px 0 0; font-size: 30px; line-height: 36px; font-weight: 700; letter-spacing: -0.02em; }
  #body { margin: 12px 0 0; font-size: 18px; line-height: 28px; color: #525252; overflow-wrap: anywhere; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <div class="card">
    <div class="mark">
      <img class="logo" src="${BOT_LOGO_URL}" alt="" width="64" height="64">
      <span class="badge${tone === "warn" ? " warn" : ""}" id="badge"><svg id="badge-ok"${tone === "warn" ? " hidden" : ""} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><svg id="badge-warn"${tone === "warn" ? "" : " hidden"} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 8v5M12 17h.01"/></svg></span>
    </div>
    <h1 id="title">${escapeHtml(title)}</h1>
    <p id="body">${escapeHtml(body)}</p>
  </div>
${script.length > 0 ? `  <script>${script}</script>\n` : ""}</body>
</html>`;
