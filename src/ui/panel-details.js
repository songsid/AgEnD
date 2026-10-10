// #1523 N2 (§3.3, Q1 = B): Details — "the Fleet side of one instance", at /ui/fleet/agent/<name>. Behind the session
// gate (/ui/js/). What it holds:
// - runtime and recent activity (what Chat's details dialog showed, now a page);
// - a read-only config summary — directory, binding, tags, description — with "Edit in Settings" (that agent's
//   Settings dialog: Settings' own staged Apply and confirmations; nothing is edited here);
// - the instance's actions (⋯), carried over with their calls and confirmations, none new: start / restart / stop (Chat's
//   ⋯), pause / wake (Settings' agent row). Deletion stays where it already lives (Chat's ⋯, Settings).
// One read of /ui/instance/<name> when it opens (#1374: nothing recurring); the live status is the app's.
import { html, useEffect, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import { PanelHeader, setTitle, statusClass, statusLabel, openDrawer } from "/assets/app-shell.js";
import { navigate } from "/assets/app-nav.js";
import { settingsPath } from "/assets/app-route.js";
import { InstanceSwitch } from "/assets/instance-switch.js";
import { Menu } from "/assets/ui-menu.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { toast } from "/assets/ui-toast.js";
import "./chat-strings.js";
import { api } from "./settings-confirm.js";
import { requestAgentSettings } from "./settings-request.js";

export function DetailsPanel({ route, navKey }) {
  const app = useStore(appStore);
  const name = route.instance;
  const inst = app.instances.find((i) => i.name === name) || null;
  useEffect(() => { setTitle(`${name} · ${t("app.details")}`); }, [name, navKey]);
  if (!app.ready) return html`<div class="panel p-details"><${PanelHeader} title=${name} /><div class="panel-body"><${Skeleton} lines=${6} /></div></div>`;
  if (!inst) {
    return html`<div class="panel p-details"><${PanelHeader} title=${name} />
      <div class="panel-body center"><${Empty} icon="alert" title=${t("chat.notFound", name)} hint=${t("chat.notFoundHint")}
        action=${html`<button type="button" class="btn only-narrow" onClick=${openDrawer}>${t("chat.backToList")}</button>`} /></div></div>`;
  }
  return html`<${DetailsView} key=${name} name=${name} inst=${inst} exec=${app.exec[name]}
    awaiting=${Object.prototype.hasOwnProperty.call(app.awaiting, name) ? app.awaiting[name] : null} />`;
}

function DetailsView({ name, inst, exec, awaiting }) {
  const lease = useLease(`details:${name}`);
  const [d, setD] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState("");
  const body = useRef(null);
  // Each read is numbered: only the latest one (on this page) may set what is shown — a Retry still on its way never
  // overwrites a newer answer, failed or not (#1561 review).
  const reads = useRef(0);
  const load = async () => {
    const mine = ++reads.current;
    const current = () => lease.current() && reads.current === mine;
    try {
      const r = await lease.fetch(`/ui/instance/${encodeURIComponent(name)}`, { headers: { "Content-Type": "application/json" } });
      if (!current()) return;
      const j = await r.json();
      if (!current()) return;
      if (!r.ok) { setFailed(true); return; }
      setFailed(false); setD(j);
    } catch { if (current()) setFailed(true); }
  };
  useEffect(() => { load(); }, [lease]);
  // Bars are sized after they are drawn, through the CSSOM (never a style attribute, #1300).
  useLayoutEffect(() => { if (body.current) for (const f of body.current.querySelectorAll(".progress-fill[data-pct]")) f.style.width = `${f.dataset.pct}%`; });

  // ── Actions: the existing calls, one at a time ──
  const act = async (key, work) => {
    if (busy) return;
    setBusy(key);
    try { await work(); } finally { if (lease.current()) setBusy(""); }
  };
  const lifecycle = (verb) => act(verb, async () => {
    let r;
    try { const res = await fetch(`/ui/${verb}/${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": "application/json" } }); r = await res.json(); }
    catch (err) { r = { error: err && err.message ? err.message : t("chat.disconnected") }; }
    if (r && r.error) toast(r.error, false);
    else toast(t(verb === "start" ? "chat.started" : verb === "stop" ? "chat.stoppedInst" : "chat.restarted", name));
  });
  const pauseWake = (verb) => act(verb, async () => {
    const res = await api(`/api/settings/instances/${encodeURIComponent(name)}/${verb}`, { method: "POST" }).catch(() => ({ ok: false, body: {} }));
    if (!res.ok) toast((res.body && res.body.error) || t("chat.dActionFailed"), false);
    else toast(t(verb === "pause" ? "chat.dPaused" : "chat.dWoken", name));
  });
  // A ClassicBot room (classicBot.yaml) keeps Classic's split: its own Settings dialog, and only the actions Settings'
  // Classic rows have (pause / wake) — never the fleet agent's (#1561 review).
  const classic = !!(d && d.kind === "classic");
  const editInSettings = () => { requestAgentSettings(name, classic ? "classic" : "agent"); navigate(settingsPath(classic ? "classic" : undefined)); };
  const st = inst.status;
  // Until its read is in, the page does not know which kind it is: no actions yet (only Edit is offered once known).
  const items = !d ? [] : classic ? [
    { key: "edit", label: t("chat.dEditInSettings"), icon: "settings", onSelect: editInSettings },
    st === "running" ? { key: "pause", label: t("chat.dPause"), icon: "pause", disabled: !!busy, onSelect: () => pauseWake("pause") } : null,
    st === "paused" ? { key: "wake", label: t("chat.dWake"), icon: "play", disabled: !!busy, onSelect: () => pauseWake("wake") } : null,
  ] : [
    { key: "edit", label: t("chat.dEditInSettings"), icon: "settings", onSelect: editInSettings },
    st === "running" ? null : st === "paused" ? null : { key: "start", label: t("chat.start"), icon: "play", disabled: !!busy, onSelect: () => lifecycle("start") },
    st === "running" ? { key: "restart", label: t("chat.restart"), icon: "restart", disabled: !!busy, onSelect: () => lifecycle("restart") } : null,
    st === "running" ? { key: "stop", label: t("chat.stopInstance"), icon: "stop", disabled: !!busy, onSelect: () => lifecycle("stop") } : null,
    st === "running" ? { key: "pause", label: t("chat.dPause"), icon: "pause", disabled: !!busy, onSelect: () => pauseWake("pause") } : null,
    st === "paused" ? { key: "wake", label: t("chat.dWake"), icon: "play", disabled: !!busy, onSelect: () => pauseWake("wake") } : null,
  ];

  const cls = statusClass(inst, exec, awaiting);
  const sub = html`<span class="status"><span class=${`dot ${cls}`} aria-hidden="true"></span>${statusLabel(inst, exec, awaiting)}</span>`;
  const src = (s) => (s === "instance" ? ` ${t("chat.configured")}` : s === "fleet-default" ? ` ${t("chat.fleetDefault")}` : "");
  const bar = (pct, level) => html`<span class="progress-bar"><span class=${`progress-fill${level ? ` ${level}` : ""}`} data-pct=${Math.max(0, Math.min(Number(pct) || 0, 100))}></span></span>`;
  const row = (k, v) => html`<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  let content;
  if (failed) content = html`<${ErrorState} message=${t("chat.loadFailed")} onRetry=${load} />`;
  else if (!d) content = html`<${Skeleton} lines=${6} />`;
  else {
    const sl = d.statusline || {}, cost = sl.cost?.total_cost_usd ?? 0, ctx = d.context_pct;
    const rl5 = sl.rate_limits?.five_hour?.used_percentage ?? 0, rl7 = sl.rate_limits?.seven_day?.used_percentage ?? 0;
    // Where it is bound, as the fleet resolves it: no channel_id is the first connection (said so); "web only" only
    // when the fleet has no connection at all (#1561 review).
    const b = d.binding || {};
    const conn = b.channel_id ? (b.implicit ? t("chat.dBindingDefault", b.channel_id) : b.channel_id) : null;
    const binding = d.room ? t("chat.dBindingRoom", d.room.name, d.room.adapter_id || t("chat.dPrimary"))
      : !conn ? t("chat.dBindingNone")
      : b.general_topic ? t("chat.dBindingGeneral", conn)
      : b.topic_id ? t("chat.dBindingTopic", conn, b.topic_id)
      : t("chat.dBindingNoTopic", conn);
    content = html`<section class="card d-config"><h3>${t("chat.dConfig")}</h3>
        ${row(t("chat.dDisplay"), d.display_name || "--")}
        ${row(t("chat.dDescription"), d.description || "--")}
        ${d.working_directory ? row(t("chat.dDirectory"), html`<span class="mono">${d.working_directory}</span>`) : null}
        ${row(t("chat.dBinding"), binding)}
        ${row(t("chat.dTags"), Array.isArray(d.tags) && d.tags.length ? html`<span class="d-tags">${d.tags.map((x) => html`<span key=${x} class="tag">${x}</span>`)}</span>` : "--")}
        <div class="d-edit"><span class="note">${t("chat.dReadOnly")}</span>
          <button type="button" class="btn btn-sm d-edit-settings" onClick=${editInSettings}>${t("chat.dEditInSettings")}</button></div></section>
      <section class="card"><h3>${t("chat.dRuntime")}</h3>
        ${row(t("chat.dBackend"), d.backend || "--")}
        ${row(t("chat.dModel"), `${d.model || sl.model?.display_name || "--"}${d.model_source === "live" ? "" : src(d.model_source)}`)}
        ${d.effort ? row(t("chat.dEffort"), `${d.effort}${src(d.effort_source)}`) : null}
        ${row(t("chat.dCost"), `$${cost.toFixed(2)} ${t("chat.dCostNote")}`)}
        ${row(t("chat.dContext"), html`<span class="pct">${ctx != null ? `${Math.round(ctx)}%` : "--"}</span>${ctx != null ? bar(ctx, ctx > 80 ? "warn" : "") : null}`)}
        ${row(t("chat.dRate5"), html`<span class="pct">${Math.round(rl5)}%</span>${bar(rl5, rl5 > 90 ? "error" : rl5 > 70 ? "warn" : "")}`)}
        ${row(t("chat.dRate7"), html`<span class="pct">${Math.round(rl7)}%</span>${bar(rl7, rl7 > 90 ? "error" : rl7 > 70 ? "warn" : "")}`)}</section>
      <section class="card"><h3>${t("chat.dActivity")}</h3>${d.recent_activity?.length ? d.recent_activity.map((a, i) => html`<div key=${i} class="activity">
        <span class="mono muted">${a.timestamp ? new Date(`${a.timestamp.replace(" ", "T")}Z`).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
        <span class="ev">${a.event}</span> ${a.summary || ""}</div>`) : html`<p class="note">${t("chat.dNoActivity")}</p>`}</section>`;
  }
  return html`<div class="panel p-details">
    <${PanelHeader} title=${name} sub=${sub} nav=${html`<${InstanceSwitch} name=${name} current="details" />`}><${Menu} items=${items} label=${t("app.more")} /></${PanelHeader}>
    <div class="panel-body"><div class="col" ref=${body}>${busy ? html`<p class="note" role="status">${t("chat.dWorking")}</p>` : null}${content}</div></div>
  </div>`;
}
