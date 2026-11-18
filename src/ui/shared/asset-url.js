// M-3328 (measured in M-3316): a stylesheet or picture a module adds to the page later (a panel's own CSS, the office
// backgrounds) under the same version as the module itself. The import map (M-3314) versions only imports, so a
// `<link href="/assets/hub.css">` or `<img src="/assets/office-cozy.png">` stayed a plain, `no-store` request on every
// open — and, after an update, a newer stylesheet in an older tab. This module is loaded through the import map, so its
// own URL carries the page's version (`/assets/v-<V>/asset-url.js`): assetUrl() puts the same <V> in front of an
// `/assets/<name>`. A tab older than the server then asks for its own <V> and gets a 404, never a newer file. Anywhere
// it is loaded by its plain path (the Hub's pages, the office share page, tests) it changes nothing.

const VERSIONED = /\/(?:assets|ui\/js)\/(v-[0-9a-f]{12})\/[^/?#]+(?:[?#].*)?$/;
const PLAIN_ASSET = /^\/assets\/[A-Za-z0-9._-]+$/;

/** assetUrl for a module loaded at `url`: `/assets/<name>` under that URL's version, or unchanged when it has none. */
export function createAssetUrl(url) {
  const m = VERSIONED.exec(String(url || ""));
  const version = m ? m[1] : null;
  return (path) => (version && PLAIN_ASSET.test(path) ? `/assets/${version}/${path.slice("/assets/".length)}` : path);
}

/** `/assets/<name>` under this page's version (unchanged where there is none). */
export const assetUrl = createAssetUrl(import.meta.url);
