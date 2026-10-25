/**
 * #2636: an Office share link's page and the static files it loads, as the share gateway serves them (office-share.ts).
 *
 * The page (`/o/<token>`) is a fixed document — no data in it, no inline script — that loads the share page's module
 * (src/ui/office-share-page.js), which reads the share's own addresses. Its modules and stylesheets are served at the
 * dashboard's own paths (`/assets/<name>`, `/ui/js/<name>`) so the Office's imports work unchanged, without a token:
 * they are the app's static code (published with AgEnD), never data — and only the files named here, the page
 * module's import closure (a test checks the list against the imports), not the directory.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "ui");
const JS = "text/javascript; charset=utf-8";

/** `/assets/<name>` → src/ui/shared/<name>: the share page's closure there, its stylesheets and the font they name. */
export const SHARE_ASSETS: Readonly<Record<string, string>> = {
  ...Object.fromEntries([
    "app-ctx.js", "app-html.js", "app-i18n.js", "app-nav.js", "app-prefs.js", "app-route.js", "app-store.js", "app-themes.js", "header-tools.js",
    "htm.module.js", "identity-color.js", "instance-nav.js", "owner-css.js", "preact-hooks.module.js", "preact.module.js", "read-stream.js",
    "side-panel.js", "text-undo.js", "ui-confirm.js", "ui-dialog.js", "ui-icons.js", "ui-states.js", "ui-toast.js", "usage-dialog.js",
    "view-roster-store.js", "view-strings.js",
  ].map(name => [name, JS])),
  "tokens.css": "text/css; charset=utf-8", "app.css": "text/css; charset=utf-8", "inter.woff2": "font/woff2",
};
/** `/ui/js/<name>` → src/ui/<name>: the share page's own module and the Office's. */
export const SHARE_MODULES: readonly string[] = [
  "office-share-page.js", "fleet-office.js", "fleet-office-model.js", "fleet-office-skin.js", "fleet-office-zones.js", "fleet-office-store.js",
  "fleet-office-editor.js", "fleet-office-layout.js", "fleet-office-pack.js", "fleet-office-overview.js", "fleet-office-view.js",
  "fleet-org.js", "fleet-canvas-layout.js", "fleet-canvas-view.js", "fleet-traffic.js",
];

const cache = new Map<string, Buffer>();
const read = (file: string): Buffer | null => {
  const hit = cache.get(file);
  if (hit) return hit;
  try { const b = readFileSync(file); cache.set(file, b); return b; } catch { return null; }
};

/** A static file the share page loads, by its path on the share origin, or null (not one of them). */
export function officeShareStatic(path: string): { body: Buffer; type: string } | null {
  const asset = /^\/assets\/([A-Za-z0-9_.-]+)$/.exec(path);
  if (asset && Object.prototype.hasOwnProperty.call(SHARE_ASSETS, asset[1]!)) {
    const name = asset[1]!;
    const body = read(join(UI_DIR, "shared", name === "inter.woff2" ? join("fonts", name) : name));
    return body ? { body, type: SHARE_ASSETS[name]! } : null;
  }
  const mod = /^\/ui\/js\/([a-z0-9_-]+\.js)$/.exec(path);
  if (mod && SHARE_MODULES.includes(mod[1]!)) {
    const body = read(join(UI_DIR, mod[1]!));
    return body ? { body, type: JS } : null;
  }
  return null;
}

/** The page's policy: its own scripts, styles, pictures and reads; nothing inline, nothing framed, no form. */
export const OFFICE_SHARE_PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; "
  + "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The page itself: the same for every share (the module reads the token from the address). */
export const OFFICE_SHARE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>AgEnD Office</title>
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/app.css">
<script type="module" src="/ui/js/office-share-page.js"></script>
</head>
<body>
<div id="app" class="app-root" data-share="1"></div>
<noscript><p class="noscript">This live Office view needs JavaScript.</p></noscript>
</body>
</html>
`;
