// #2636: an Office share link's page (/o/<token> on the share tunnel, src/office-share.ts) — the live Office view for
// people outside the fleet, read-only, with no sign-in. The same Office as Fleet → Org chart → Office (fleet-office.js),
// fed by the share's own reads instead of the app shell's: its status and structure (/o/<t>/state, every POLL_MS while
// the page is shown), the offices, acts and skin packs (the Office's own reads, sent to the share's addresses by the
// lease's fetch). Nothing opens a chat, edits or writes; there is no other page. When the share ends (revoked, expired,
// its office deleted) its reads answer 404 and the page says so and stops.
import { html, render, useEffect, useMemo, useState } from "/assets/app-html.js";
import { appStore, useStore } from "/assets/app-store.js";
import { createLease } from "/assets/app-ctx.js";
import { t, register } from "/assets/app-i18n.js";
import { buildOrgView } from "./fleet-org.js";
import { createTrafficStore, POLL_MS } from "./fleet-traffic.js";
import { Office } from "./fleet-office.js";
import { ALL_ID } from "./fleet-office-overview.js";

register("share", {
  en: { title: "Office", live: "Live view", ends: "until {0}", readOnly: "Read-only: names and states only.", ended: "This Office link has ended.", loading: "Loading the office…", offline: "Can't reach the office right now. Trying again…" },
  "zh-TW": { title: "辦公室", live: "即時畫面", ends: "到 {0} 為止", readOnly: "唯讀：只顯示名稱與狀態。", ended: "這個辦公室連結已結束。", loading: "正在載入辦公室…", offline: "目前連不上辦公室，正在重試…" },
});
const to = (k, ...v) => t(`share.${k}`, ...v);

/** The share's own address: `/o/<token>` (the page's path). */
export function shareBase(pathname) {
  const m = /^\/o\/([A-Za-z0-9_-]{43})\/?$/.exec(pathname || "");
  return m ? `/o/${m[1]}` : null;
}

/** The Office's reads, at the share's addresses (anything else is not the share's to answer: refused here). */
export function shareUrl(base, path) {
  const p = String(path);
  if (p === "/ui/offices") return `${base}/offices`;
  if (p === "/ui/office-acts") return `${base}/office-acts`;
  if (p === "/ui/office-skins" || p.startsWith("/ui/office-skins/") || p.startsWith("/ui/office-skins?")) return `${base}${p.slice(3)}`;
  return null;
}

/** A lease whose fetch reads the share's addresses (createLease's timers), refusing any other. */
export function shareLease(base, timers = globalThis) {
  return createLease({
    setTimeout: (...a) => timers.setTimeout(...a), clearTimeout: (h) => timers.clearTimeout(h),
    setInterval: (...a) => timers.setInterval(...a), clearInterval: (h) => timers.clearInterval(h),
    fetch: (path, opts) => {
      const url = shareUrl(base, path);
      return url ? timers.fetch(url, opts) : Promise.resolve(new Response("", { status: 404 }));
    },
  });
}

/** The share's /state into the app store's shape (the status frame's, as app-store.js takes it). */
export function appFromState(d) {
  const instances = Array.isArray(d && d.instances) ? d.instances : [];
  const exec = {}, awaiting = {};
  for (const i of instances) {
    exec[i.name] = (i.execution_state !== undefined ? i.execution_state : i.state) ?? null;
    if (i.state === "awaiting_input") awaiting[i.name] = "";
  }
  return { ready: true, instances, exec, awaiting, needs: Array.isArray(d && d.needs) ? d.needs : [], connection: "polling" };
}

const clock = (ms) => {
  try { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(ms)); } catch { return ""; }
};

export function SharePage({ base, timers = globalThis, pollMs = POLL_MS }) {
  const lease = useMemo(() => shareLease(base, timers), [base]);
  const traffic = useMemo(createTrafficStore, []);
  const [state, setState] = useState({ phase: "loading" });   // loading | live | ended | offline
  const [items, setItems] = useState([]);
  useEffect(() => {
    let stopped = false;
    const read = async () => {
      try {
        const r = await timers.fetch(`${base}/state`, { method: "GET", headers: { Accept: "application/json" } });
        if (stopped || !lease.current()) return;
        if (r.status === 404) { stopped = true; setState({ phase: "ended" }); return; }
        if (!r.ok) { setState((s) => (s.phase === "live" ? s : { phase: "offline" })); return; }
        const d = await r.json();
        if (stopped || !lease.current()) return;
        appStore.set((s) => ({ ...s, ...appFromState(d) }));
        if (d.traffic && traffic.load(d.traffic)) setItems(traffic.items());
        setState({ phase: "live", org: d.org, office: typeof d.office === "string" ? d.office : null, ends: typeof d.ends === "number" ? d.ends : null });
      } catch { if (!stopped) setState((s) => (s.phase === "live" ? s : { phase: "offline" })); }
    };
    void read();
    const hs = [
      lease.interval(() => { if (!stopped && !globalThis.document?.hidden) void read(); }, pollMs),
      lease.interval(() => { if (traffic.sweep()) setItems(traffic.items()); }, 1000),
    ];
    return () => { stopped = true; for (const h of hs) lease.clear(h); };
  }, [lease]);
  useEffect(() => () => lease.dispose(), [lease]);
  const app = useStore(appStore);
  const view = useMemo(() => (state.phase === "live" ? buildOrgView(state.org, app) : null), [state, app.instances, app.needs]);
  if (state.phase === "ended") return html`<main class="share-page share-ended"><p>${to("ended")}</p></main>`;
  return html`<main class="share-page">
    <header class="share-head">
      <strong>${to("title")}</strong>
      <span class="muted">${to("live")}${state.ends ? ` · ${to("ends", clock(state.ends))}` : ""}</span>
      <span class="muted share-note">${to("readOnly")}</span>
    </header>
    ${state.phase === "offline" ? html`<p class="note share-note" role="status">${to("offline")}</p>` : null}
    ${view ? html`<div class="share-stage"><${Office} view=${view} traffic=${items} lease=${lease} assetUrl=${(p) => shareUrl(base, p) || p}
      opening=${state.office === "all" ? ALL_ID : state.office || undefined} /></div>`
      : html`<p class="muted share-loading" role="status">${to("loading")}</p>`}
  </main>`;
}

/** Mount on the page (the module's entry): the share's address from the path, else nothing to show. */
export function mount(root = globalThis.document?.getElementById("app")) {
  const base = shareBase(globalThis.location?.pathname);
  if (!root || !base) return;
  globalThis.document.body.dataset.webTransport = "poll";
  render(html`<${SharePage} base=${base} />`, root);
}

if (globalThis.document?.getElementById?.("app")?.dataset?.share === "1") mount();
