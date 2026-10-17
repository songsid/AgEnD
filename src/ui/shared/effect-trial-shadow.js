/** #2039: fixed host-only closed shadow shell. Owner CSS has no exported parts or slots into it. */
const roots = new WeakMap();
const clear = root => { while (root.firstChild) root.removeChild(root.firstChild); };
function sheetOf(host, record) {
  try {
    const link = record.link, sheet = link?.sheet;
    return record.ready && !record.dead && roots.get(record.panel)?.current === record && record.root.mode === "closed" && record.root.host === record.panel
      && link.getRootNode() === record.root && link.isConnected && link.disabled === false && sheet?.ownerNode === link && sheet.disabled === false
      && sheet.href === new URL("/assets/effect-trial.css", host.location.origin).href && typeof sheet.insertRule === "function" && typeof sheet.deleteRule === "function" && sheet.cssRules ? sheet : null;
  } catch { return null; }
}
/** Reflect only a shell issued here, after its fixed same-origin stylesheet loaded. Never a serialized capability. */
export function effectTrialShadow(host, panel) {
  const record = roots.get(panel)?.current;
  return record && sheetOf(host, record) === record.proof?.sheet ? record.proof : null;
}
export function createEffectTrialShadow({ window: host, panel, title, labels, onStop, onClose, onReady, onError } = {}) {
  if (!host?.document || panel?.ownerDocument !== host.document || typeof panel.attachShadow !== "function" || typeof onReady !== "function" || typeof onError !== "function") return null;
  let slot = roots.get(panel), cleanup = null;
  const clock = () => (host.performance ?? globalThis.performance).now(), later = host.setTimeout?.bind(host) ?? globalThis.setTimeout, cancel = host.clearTimeout?.bind(host) ?? globalThis.clearTimeout;
  try {
    if (slot?.current && !slot.current.dead) return null;
    if (!slot) { slot = { root: panel.attachShadow({ mode: "closed" }), current: null }; roots.set(panel, slot); }
    const root = slot.root; clear(root);
    const doc = host.document, element = (tag, cls) => { const el = doc.createElement(tag); el.className = cls; return el; };
    const link = element("link", "effect-trial-style"); link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/effect-trial.css");
    const head = element("header", "effect-trial-head"), label = element("strong", "effect-trial-label"), name = element("span", "effect-trial-title"), close = element("button", "effect-trial-close"), controls = element("div", "effect-trial-controls"), stop = element("button", "effect-trial-stop"), body = element("div", "effect-trial-body"), stage = element("div", "effect-trial-stage"), note = element("p", "effect-trial-note");
    close.setAttribute("type", "button"); stop.setAttribute("type", "button"); stage.setAttribute("aria-hidden", "true");
    head.append(label, name, close); controls.append(stop); body.append(stage);
    const nodes = [head, controls, body, note]; for (const el of nodes) el.setAttribute("hidden", "");
    const began = clock(); if (!Number.isFinite(began) || began < 0) return null;
    let timer = null;
    const record = { panel, root, link, stage, head, controls, body, note, close, stop, ready: false, dead: false, proof: null }; slot.current = record;
    const text = (nextTitle, nextLabels) => {
      if (record.dead || !nextLabels) return;
      label.textContent = nextLabels.label; name.textContent = typeof nextTitle === "string" ? nextTitle : "";
      close.textContent = nextLabels.close; stop.textContent = nextLabels.stop; note.textContent = nextLabels.note;
      panel.setAttribute("data-effect-trial-theme", doc.documentElement.dataset.theme === "dark" ? "dark" : "light");
    };
    const failed = () => { if (!record.dead) { dispose(); try { onError("stage_unavailable"); } catch { /* cleanup already owns failure */ } } };
    const loaded = () => {
      if (record.dead || record.ready || slot.current !== record) return;
      const at = clock(); if (!Number.isFinite(at) || at < began || at - began >= 10000) { failed(); return; }
      record.ready = true; const sheet = sheetOf(host, record);
      if (!sheet) { failed(); return; }
      cancel(timer); timer = null;
      record.proof = Object.freeze({ panel, root, link, sheet, stage, head, controls, body, note, close, stop });
      for (const el of nodes) el.removeAttribute("hidden");
      try { onReady(record.proof); } catch { failed(); }
    };
    const stopClick = () => { if (!record.dead) onStop?.(); }, closeClick = () => { if (!record.dead) onClose?.(); };
    function dispose() {
      if (record.dead) return; record.dead = true; cancel(timer); timer = null;
      link.removeEventListener("load", loaded); link.removeEventListener("error", failed); stop.removeEventListener("click", stopClick); close.removeEventListener("click", closeClick);
      if (slot.current === record) { slot.current = null; clear(root); }
    }
    cleanup = dispose;
    link.addEventListener("load", loaded); link.addEventListener("error", failed); stop.addEventListener("click", stopClick); close.addEventListener("click", closeClick);
    text(title, labels); timer = later(failed, 10000); root.append(link, ...nodes);
    return Object.freeze({ dispose, text });
  } catch { cleanup?.(); return null; }
}
