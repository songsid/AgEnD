// #1389: Fleet → Org chart (/ui/fleet/org) — General at the top, then the teams fleet.yaml defines, then their
// instances; each node names the instance, says what it does, which backend and model it runs, how it is doing now,
// and links to its thread. Behind the session gate (/ui/js/), imported by the Fleet panel.
//
// Presentation only (the user's Discord-first rule): nothing is edited here, and nothing here is a source of truth.
// The structure is GET /ui/org (read when the tab is opened — a person's navigation); the live state is the app store
// the shell already keeps from the stream (status, activity, `needs`), so the chart moves with it and reads nothing
// on a timer (#1374).
import { html } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { chatPath } from "/assets/app-route.js";
import { Empty, Skeleton } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";

register("org", {
  en: {
    title: "Org chart", general: "General", unteamed: "Not in a team", members: "{0} members", member: "1 member", instances: "{0} instances", instance: "1 instance",
    needs: "Needs you", working: "Working", idle: "Idle", stuck: "Looks stuck", paused: "Paused", stopped: "Stopped", crashed: "Crashed",
    missing: "Not in the fleet", thread_discord: "Discord thread", thread_telegram: "Telegram topic", openChat: "Open chat",
    classic: "ClassicBot room", empty: "No instances yet", emptyHint: "Instances and teams show here once the fleet has them.",
    noTeams: "No teams yet — define them in Fleet → Teams to group the chart.", newTab: "(opens in a new tab)",
  },
  "zh-TW": {
    title: "組織圖", general: "General", unteamed: "未加入 team", members: "{0} 名成員", member: "1 名成員", instances: "{0} 個 instance", instance: "1 個 instance",
    needs: "等你回應", working: "工作中", idle: "閒置", stuck: "似乎卡住", paused: "已暫停", stopped: "已停止", crashed: "已當掉",
    missing: "不在 fleet 中", thread_discord: "Discord 討論串", thread_telegram: "Telegram topic", openChat: "開啟聊天",
    classic: "ClassicBot 頻道", empty: "還沒有 instance", emptyHint: "fleet 有 instance 和 team 後會顯示在這裡。",
    noTeams: "還沒有 team——到 Fleet → Teams 定義後，組織圖會依 team 分組。", newTab: "（在新分頁開啟）",
  },
});
const to = (k, ...v) => t(`org.${k}`, ...v);
const count = (one, many, n) => (n === 1 ? to(one) : to(many, n));

/** The states a node can show, most pressing first (a team's summary lists them in this order). */
export const ORG_STATES = ["needs", "crashed", "stuck", "working", "idle", "paused", "stopped", "missing"];
const DOT = { needs: "warn", crashed: "bad", stuck: "warn", working: "busy", idle: "ok", paused: "off", stopped: "off", missing: "off" };

/**
 * One instance's live state, from the app store: `i` its status entry (null: the fleet does not list it), `exec` the
 * raw execution state, `awaiting` what it waits on at its terminal (null: nothing), `needs` how many "Needs you" items
 * name it (#1398's registry, over the stream).
 */
export function orgState(i, exec, awaiting, needs) {
  if (!i) return "missing";
  if (awaiting != null || needs > 0) return "needs";
  if (i.status === "crashed") return "crashed";
  if (i.status === "paused") return "paused";
  if (i.status !== "running") return "stopped";
  if (exec === "stuck") return "stuck";
  if (exec === "working") return "working";
  return "idle";
}

/**
 * The chart: the structure from /ui/org, the nodes and their states from the app store. General on top; each team with
 * its members in fleet.yaml's order (an instance in two teams shows in both: that is its place in each); then the
 * instances in no team, in the dashboard's order. General is not repeated there.
 */
export function buildOrgView(org, app) {
  const live = new Map((app.instances || []).map((i) => [i.name, i]));
  const needs = new Map();
  for (const item of Array.isArray(app.needs) ? app.needs : []) needs.set(item.instance, (needs.get(item.instance) || 0) + 1);
  const awaiting = app.awaiting || {};
  const info = (org && org.instances) || {};
  const node = (name) => {
    const i = live.get(name) || null;
    const waits = Object.prototype.hasOwnProperty.call(awaiting, name) ? awaiting[name] : null;
    return { name, i, info: info[name] || {}, state: orgState(i, (app.exec || {})[name], waits, needs.get(name) || 0) };
  };
  const counts = (nodes) => {
    const c = {};
    for (const n of nodes) c[n.state] = (c[n.state] || 0) + 1;
    return ORG_STATES.filter((s) => c[s]).map((s) => [s, c[s]]);
  };
  const general = ((org && org.general) || []).filter((n) => live.has(n));
  const teams = ((org && org.teams) || []).map((team) => {
    const nodes = (team.members || []).map(node);
    return { name: team.name, description: team.description || "", nodes, counts: counts(nodes) };
  });
  const placed = new Set([...general, ...teams.flatMap((team) => team.nodes.map((n) => n.name))]);
  const rest = (app.instances || []).filter((i) => !placed.has(i.name)).map((i) => node(i.name));
  const all = (app.instances || []).map((i) => node(i.name));
  return { top: general.map(node), teams, rest: { nodes: rest, counts: counts(rest) }, total: all.length, counts: counts(all) };
}

function Summary({ counts }) {
  return html`<ul class="org-counts">${counts.map(([s, n]) => html`<li key=${s} class=${`org-count st-${s}`}>
    <span class=${`dot ${DOT[s]}`} aria-hidden="true"></span>${n} ${to(s)}</li>`)}</ul>`;
}

function Node({ n }) {
  const alias = n.i && typeof n.i.display_name === "string" && n.i.display_name.trim() && n.i.display_name.trim() !== n.name ? n.i.display_name.trim() : "";
  const thread = n.info.thread;
  const model = n.i && n.i.model ? n.i.model : "";
  return html`<li class=${`org-node st-${n.state}`}>
    <div class="org-node-head">
      <span class=${`dot ${DOT[n.state]}`} aria-hidden="true"></span>
      <span class="org-names">${alias ? html`<strong class="org-alias">${alias}</strong><span class="org-name mono">${n.name}</span>`
        : html`<strong class="org-name mono">${n.name}</strong>`}</span>
      <span class=${`org-state st-${n.state}`}>${to(n.state)}</span>
    </div>
    ${n.info.description ? html`<p class="org-desc" title=${n.info.description}>${n.info.description}</p>` : null}
    ${n.i ? html`<div class="org-meta">${n.i.backend ? html`<span class="org-chip">${n.i.backend}</span>` : null}
      ${model ? html`<span class="org-model mono" title=${model}>${model}</span>` : null}
      ${n.info.classic ? html`<span class="org-chip">${to("classic")}</span>` : null}</div>` : null}
    ${n.i || thread ? html`<div class="org-links">
      ${thread ? html`<a class="org-link" href=${thread.url} target="_blank" rel="noopener noreferrer">
        <${Icon} name="external" size=${14} />${to(`thread_${thread.platform}`)}<span class="sr-only"> ${to("newTab")}</span></a>` : null}
      ${n.i ? html`<a class="org-link" href=${chatPath(n.name)}><${Icon} name="chat" size=${14} />${to("openChat")}</a>` : null}
    </div>` : null}
  </li>`;
}

function Team({ id, name, description, nodes, counts, icon }) {
  return html`<section class="org-team" aria-labelledby=${id}>
    <header class="org-team-head">
      <h3 id=${id}><${Icon} name=${icon} size=${16} /><span>${name}</span></h3>
      ${description ? html`<p class="org-team-desc">${description}</p>` : null}
      <div class="org-team-sub"><span class="muted">${count("member", "members", nodes.length)}</span><${Summary} counts=${counts} /></div>
    </header>
    <ul class="org-nodes">${nodes.map((n) => html`<${Node} key=${n.name} n=${n} />`)}</ul>
  </section>`;
}

/** The tab's body. `org`: what /ui/org answered (the Fleet panel's loader); `app`: the app store. */
export function OrgChart({ org, app }) {
  if (!app.ready) return html`<${Skeleton} lines=${4} />`;
  const view = buildOrgView(org, app);
  if (!view.total) return html`<${Empty} icon="team" title=${to("empty")} hint=${to("emptyHint")} />`;
  return html`<div class="org">
    <div class="list-head org-head"><span>${count("instance", "instances", view.total)}</span><${Summary} counts=${view.counts} /></div>
    ${view.top.length ? html`<section class="org-top" aria-labelledby="org-general">
      <h3 id="org-general" class="sr-only">${to("general")}</h3>
      <ul class="org-nodes">${view.top.map((n) => html`<${Node} key=${n.name} n=${n} />`)}</ul>
    </section>` : null}
    ${view.teams.length ? null : html`<p class="note org-note">${to("noTeams")}</p>`}
    <div class="org-teams">
      ${view.teams.map((team, k) => html`<${Team} key=${team.name} id=${`org-team-${k}`} icon="team" ...${team} />`)}
      ${view.rest.nodes.length ? html`<${Team} id="org-rest" icon="fleet" name=${to("unteamed")} description="" ...${view.rest} />` : null}
    </div>
  </div>`;
}
