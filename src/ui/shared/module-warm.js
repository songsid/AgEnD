// M-3314: a panel opened after the page loaded (Settings, Fleet…) asks for its whole module graph at once, not one
// import level at a time over a slow link. The shell carries the served modules' static imports (#agend-modules, a
// signed-in admin's page only) and loads this file under its version (/assets/v-<V>/); a preload names the same
// versioned URL the import map gives the import, so the browser fetches each file once. Anywhere else (no graph, a
// plain path) it does nothing and the import loads as before.

const VERSIONED = /\/assets\/(v-[0-9a-f]{12})\/module-warm\.js(?:[?#]|$)/;

function readGraph(doc) {
  try { const el = doc && doc.getElementById("agend-modules"); return el ? JSON.parse(el.textContent || "null") : null; } catch { return null; }
}

/** The module URLs (plain) `entry` imports statically, itself included. */
export function closureOf(graph, entry) {
  const seen = new Set(), stack = [entry];
  while (stack.length) { const u = stack.pop(); if (seen.has(u) || !graph || !Object.prototype.hasOwnProperty.call(graph, u)) continue; seen.add(u); for (const d of graph[u]) stack.push(d); }
  return [...seen];
}

/** A warmer over this page: `warm(entry)` adds one modulepreload per module of the entry's graph not asked for yet. */
export function createWarmer({ doc = globalThis.document, url = import.meta.url } = {}) {
  const m = VERSIONED.exec(url);
  const graph = m ? readGraph(doc) : null;
  const version = m ? m[1] : null;
  return function warm(entry) {
    if (!graph || !version || !doc || !doc.head) return 0;
    let added = 0;
    for (const u of closureOf(graph, entry)) {
      const href = u.replace(/^\/(assets|ui\/js)\//, `/$1/${version}/`);
      if (doc.head.querySelector(`link[rel="modulepreload"][href="${href}"]`)) continue;
      const link = doc.createElement("link");
      link.setAttribute("rel", "modulepreload"); link.setAttribute("href", href);
      doc.head.appendChild(link); added++;
    }
    return added;
  };
}

export const warmModules = createWarmer();
