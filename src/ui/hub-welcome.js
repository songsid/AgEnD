// #3298 S-89, M-3190 (Argon's chat-first review): what the server's welcome projection (GET /hub/v1/me/welcome) says, on two
// pages. 對話 is chat-first — the launcher's frame here adds only a one-line note when chatting is not available, the
// administrator's dismissible "Hub ready" line on a fresh Hub, and the Fleet status line (desktop). 我分享的 Agent carries
// 「我的 Fleet」: the person's Fleets as rows (revoke in a ⋯ menu, with its confirm) and the pairing steps — collapsed behind
// 「＋ 連接另一個 Fleet」 once one is connected. It is a DISPLAY of the projection: it grants nothing, and every chat, pairing or
// sharing action asks the server again. An answer the directory couldn't give is "can't be checked right now" with Retry.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { ErrorState, Skeleton } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { Menu } from "/assets/ui-menu.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { hubClient } from "./hub-client.js";
import { hg } from "./hub-group-strings.js";
import { hr } from "./hub-read-strings.js";
import { hq } from "./hub-quick-strings.js";
import { QuickPairingGuide } from "./hub-quick-pairing.js";
import { displayHost, joinSentence, otherWaysLabel, pasteLeadLabel } from "./hub-join-steps.js";

const FLEET_STATUS = { active: "fleetActive", suspended: "fleetPaused", revoked: "fleetRevoked", unknown: "fleetUnknown" };

/** Why an entry is unavailable, in the person's words. */
export function reasonText(entry, fallback) {
  if (!entry) return hg(fallback);
  if (entry.state === "unknown") return hg("unknown");
  const r = entry.reason;
  return hg(r === "person-denied" ? "deniedPerson" : r === "ineligible" ? "ineligible" : r === "suspended" ? "suspended" : fallback);
}

/** The welcome projection, read once per mount: { w, error ("busy" | "unknown" | null), load, refresh }. Backpressure retries itself. */
export function useWelcome() {
  const c = hubClient();
  const [w, setW] = useState(null), [error, setError] = useState(null);
  const live = useRef(true), generation = useRef(0), retry = useRef(null);
  const load = async () => {
    if (!live.current) return;
    clearTimeout(retry.current); retry.current = null;
    const mine = ++generation.current;
    const current = () => live.current && mine === generation.current;
    const failed = (r) => {
      if (!current()) return;
      setError(r.code === "backpressure" ? "busy" : "unknown");
      if (r.code === "backpressure") {
        const seconds = Number(r.retryAfter);
        retry.current = setTimeout(() => { if (current()) void load(); },
          (Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.min(300, seconds)) : 10) * 1000);
      }
    };
    setError(null); setW(null);
    try {
      const r = await c.welcome();
      if (!current()) return;
      if (!r.ok) { failed(r); return; }
      setW(r);
    } catch { failed({ code: "unreachable" }); }
  };
  useEffect(() => { live.current = true; void load(); return () => {
    live.current = false; generation.current++; clearTimeout(retry.current);
  }; }, []);
  const refresh = async () => { const r = await c.welcome(); if (live.current && r.ok) setW(r); };
  return { w, error, load, refresh };
}

const DISMISS_KEY = "agend_hub_ready_dismissed";
const dismissedReady = () => { try { return globalThis.localStorage?.getItem(DISMISS_KEY) === "1"; } catch { return false; } };

/**
 * M-3190: the launcher's frame on a Hub with group permissions — above the agent rows, the administrator's one-line "Hub ready"
 * (only while no Fleet is connected to this Hub; dismissible) and a note when chatting isn't available now; below them, the Fleet
 * status line (desktop only: hub-chat.css). The rows are the caller's (`children`).
 */
export function ChatLauncherFrame({ admin = false, features = [], children = null }) {
  const c = hubClient(), { w, error, load } = useWelcome();
  const companyJoin = Array.isArray(features) && features.includes("company-join-v1");
  const [fresh, setFresh] = useState(false), [dismissed, setDismissed] = useState(dismissedReady);
  useEffect(() => {
    if (!admin || !companyJoin || typeof c.adminOverview !== "function") return;
    let live = true;
    c.adminOverview().then((r) => { if (live && r && r.ok) setFresh(!(r.fleets || []).some((f) => f.status === "active")); }, () => {});
    return () => { live = false; };
  }, [admin, companyJoin]);
  const dismiss = () => { setDismissed(true); try { globalThis.localStorage?.setItem(DISMISS_KEY, "1"); } catch { /* this tab only */ } };
  const legacy = w?.mode === "legacy", chat = w?.chat || {}, connect = w?.connect || {};
  const noActions = !!w && !legacy && chat.state !== "allow" && connect.state !== "allow" && chat.state !== "unknown" && connect.state !== "unknown";
  const fleets = Array.isArray(connect.fleets) ? connect.fleets.filter((f) => f.status !== "revoked") : [];
  return html`${admin && fresh && !dismissed ? html`<div class="hub-launch-banner" role="status" data-welcome="ready"><${Icon} name="info" size=${16} />
      <span>${hg("readyBanner")} <a href="/ui/hub/admin?view=manage">${hg("readyGo")}</a></span>
      <button type="button" class="icon-btn" aria-label=${hg("readyDismiss")} title=${hg("readyDismiss")} onClick=${dismiss}><${Icon} name="close" size=${16} /></button></div>` : null}
    ${error === "busy" ? html`<p class="note" role="status" data-welcome="busy">${hr("busy")}</p>` : null}
    ${error === "unknown" || chat.state === "unknown" ? html`<p class="note" role="status" data-welcome="unknown">${hg("unknown")} <button type="button" class="btn btn-sm" onClick=${load}>${hg("retry")}</button></p>` : null}
    ${noActions ? html`<p class="note" role="status" data-welcome="no-actions">${hg("noActions")} ${hg("contactAdmin")}</p>`
      : w && !legacy && chat.state !== "allow" && chat.state !== "unknown" ? html`<p class="note" role="status" data-welcome="chat-off">${reasonText(chat, "contactAdmin")}</p>` : null}
    ${children}
    ${w && !legacy && connect.state === "allow" ? html`<p class="hub-launch-foot" data-welcome="fleets">${fleets.length
      ? html`<span class="hub-launch-ok" aria-hidden="true">●</span> ${hg("footFleets", fleets.length, fleets.map((f) => f.label || f.id).join(hg("listSep")))} · <a href="/ui/hub/exposures">${hg("footManage")}</a>`
      : html`${hg("footNone")} <a href="/ui/hub/exposures">${hg("footConnect")}</a>`}</p>` : null}`;
}

/** A Fleet row's ⋯: 撤銷此 Fleet, after the same confirm as before (it loses Hub access at once; nothing else is touched). */
function FleetRowMenu({ fleet, onRevoked }) {
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const live = useRef(true); useEffect(() => () => { live.current = false; }, []);
  if (!Number.isSafeInteger(fleet.generation) || fleet.status === "revoked") return null;
  const revoke = async () => {
    if (busy) return;
    if (!(await confirmDialog({ message: hq("revokeAsk", fleet.label || fleet.id), confirmLabel: hq("revoke"), danger: true })) || !live.current) return;
    setBusy(true); setFailed(false);
    const r = await hubClient().revokeOwnFleet(fleet.id, fleet.generation);
    if (!live.current) return;
    setBusy(false); if (r.ok) onRevoked(); else setFailed(true);
  };
  return html`<${Menu} cls="hub-fleet-menu" label=${hg("fleetMenu", fleet.label || fleet.id)} disabled=${busy}
      items=${[{ key: "revoke", label: hq("revoke"), icon: "trash", danger: true, onSelect: () => { void revoke(); } }]} />
    ${failed ? html`<small class="err" role="alert">${hq("revokeFailed")}</small>` : null}`;
}

/** The Hub's address to paste in AgEnD's Settings → Hub, with its copy button. */
function AddressChip({ host }) {
  const [copied, setCopied] = useState(null);
  const copy = async () => { try { await navigator.clipboard.writeText(host); setCopied("copied"); } catch { setCopied("copyFailed"); } };
  return html`<span class="hub-address-chip"><code>${host}</code><button type="button" class="btn btn-sm" onClick=${copy}>${hg(copied === "copied" ? "copied" : "copy")}</button></span>
    ${copied === "copyFailed" ? html`<small class="err" role="alert">${hg("copyFailed")}</small>` : null}`;
}

/**
 * M-3190: 我分享的 Agent → 「我的 Fleet」. `quick`: the session offers quick pairing (the person may revoke their own Fleets and
 * pair from here). `admin` never reads the "your Hub administrator connects fleets" line. The pairing steps show while no Fleet is
 * connected, else behind 「＋ 連接另一個 Fleet」; at the limit, the limit line instead.
 */
export function MyFleetsCard({ quick = false, admin = false, features = [], compact = false }) {
  const c = hubClient(), { w, error, load, refresh } = useWelcome();
  const companyJoin = Array.isArray(features) && features.includes("company-join-v1");
  const [joinOn, setJoinOn] = useState(false), [adding, setAdding] = useState(false);
  // #3698 r1 (Fable): the session's company-join-v1 says joining is composed, not that it is switched on — the public metadata says.
  useEffect(() => {
    if (!companyJoin || typeof c.joinMetadata !== "function") return;
    let live = true;
    c.joinMetadata().then((r) => { if (live) setJoinOn(!!r && r.ok === true && Array.isArray(r.features) && r.features.includes("company-join-v1")); }, () => {});
    return () => { live = false; };
  }, [companyJoin]);
  const head = (count) => html`<h3>${hg("fleetsTitle")}${count ? html` <small class="note">${compact ? " · " : ""}${count}</small>` : null}</h3>`;
  if (error) return html`<section class="card hub-my-fleets">${head()}${error === "busy"
    ? html`<p class="note" role="status" data-welcome="busy">${hr("busy")}</p>` : html`<${ErrorState} message=${hg("unknown")} onRetry=${load} />`}</section>`;
  if (!w) return html`<section class="card hub-my-fleets" aria-busy="true">${head()}<${Skeleton} variant="rows" lines=${2} /></section>`;
  const legacy = w.mode === "legacy", connect = w.connect || {};
  const connectOk = !legacy && connect.state === "allow";
  const fleets = Array.isArray(connect.fleets) ? connect.fleets : [], max = Number(connect.maxFleets) || 0;
  const quickOn = quick && c.quickPairingV1;
  const used = fleets.filter((f) => f.status !== "revoked").length;
  const atLimit = connectOk && max > 0 && used >= max;
  const host = companyJoin && joinOn && joinSentence(location.origin) ? displayHost(location.origin) : "";
  // The steps to connect one (more): the address to paste (step 3 of company join), else the pairing-code line — never to an
  // administrator — and the other ways (quick pairing).
  const steps = html`<div class="hub-pair-steps">
    ${host ? html`<p class="note" data-welcome="sentence">${pasteLeadLabel()}</p><${AddressChip} host=${host} />`
      : !admin && (legacy || !quickOn) ? html`<p class="note">${hg("connectManual")}</p>` : null}
    ${quickOn ? html`<details class="s-ui-disclosure hub-welcome-other"><summary>${otherWaysLabel()}</summary><div class="s-disclosure-body">
      <${QuickPairingGuide} allowed=${connectOk && !atLimit} publishAllowed=${w.publish?.state === "allow"} onConnected=${refresh} /></div></details>` : null}
  </div>`;
  return html`<section class="card hub-my-fleets" data-entry="connect"><div class="field-row hub-my-fleets-head">${head(connectOk && max > 0 ? hg("connectCount", used, max) : "")}${compact && used && connectOk && !atLimit && !adding ? html`<button type="button" class="btn btn-sm hub-pair-more" onClick=${() => setAdding(true)}>${hg("connectAnother")}</button>` : null}</div>
    ${!compact && fleets.length ? html`<div class="hub-rows">${fleets.map((f) => html`<div key=${f.id} class="s-row hub-row" data-fleet=${f.id}>
      <span class="hub-row-text"><strong>${f.label || f.id}</strong></span>
      <span class=${`tag${f.status === "active" ? " ok" : f.status === "suspended" || f.status === "unknown" ? " warn" : ""}`} data-fleet-status=${f.status}>${hg(FLEET_STATUS[f.status] || "fleetUnknown")}</span>
      ${quickOn ? html`<${FleetRowMenu} fleet=${f} onRevoked=${load} />` : null}</div>`)}</div>` : !compact ? html`<p class="note">${hg("connectHint")}</p>` : null}
    ${!legacy && !connectOk ? html`<p class="note">${w.chat?.state === "allow" && connect.reason === "no-group" ? hg("connectNotIncluded") : reasonText(connect, "contactAdmin")}</p>`
      : atLimit ? html`<p class="note" data-welcome="limit">${hg("connectLimit")}</p>`
      : !used || adding ? steps
      : compact ? null : html`<button type="button" class="btn btn-sm hub-pair-more" onClick=${() => setAdding(true)}>${hg("connectAnother")}</button>`}
    ${!legacy && w.publish && w.publish.state !== "allow" && connectOk ? html`<p class="note" data-welcome="publish">${hg("publishNot")}</p>` : null}
  </section>`;
}
