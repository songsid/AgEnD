// #3298 S-89: the signed-in welcome on a Hub with group permissions — two large entries, "Chat with an agent" and "Connect your
// fleet", shaped by what this person may do now (no actions / ask only / full). It is a DISPLAY of the server's welcome
// projection (GET /hub/v1/me/welcome): it grants nothing, and every chat, pairing or sharing action asks the server again.
// An answer the directory couldn't give is "can't be checked right now" with Retry, never a cached yes. Shared components:
// a lead line, card, btn, tag, note, Skeleton/ErrorState; the two cards sit in .hub-welcome (hub.css: a two-up grid, one column
// on a phone).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { ErrorState, Skeleton } from "/assets/ui-states.js";
import { navigate } from "/assets/app-nav.js";
import { hubClient, hubName } from "./hub-client.js";
import { hg } from "./hub-group-strings.js";
import { hr } from "./hub-read-strings.js";
import { OwnedFleetRevoke, QuickPairingGuide } from "./hub-quick-pairing.js";
import { joinSentence, otherWaysLabel } from "./hub-join-steps.js";
import { CompanyJoinAdminCard } from "./hub-company-join.js";

const FLEET_STATUS = { active: "fleetActive", suspended: "fleetPaused", revoked: "fleetRevoked", unknown: "fleetUnknown" };

/** Why an entry is unavailable, in the person's words. */
export function reasonText(entry, fallback) {
  if (!entry) return hg(fallback);
  if (entry.state === "unknown") return hg("unknown");
  const r = entry.reason;
  return hg(r === "person-denied" ? "deniedPerson" : r === "ineligible" ? "ineligible" : r === "suspended" ? "suspended" : fallback);
}

/**
 * `onChats` opens the chat list (the caller's own navigation). `askable` is how many agents are shared with this person
 * (the catalog's own count), so a new owner with nothing shared reads "No agents have been shared with you yet".
 */
export function HubWelcome({ name, quick = false, onChats = () => navigate("/ui/hub?chats=1"), admin = false, features = [] }) {
  const c = hubClient();
  const [w, setW] = useState(null), [askable, setAskable] = useState(null), [error, setError] = useState(null);
  const live = useRef(true), generation = useRef(0), retry = useRef(null);
  const load = async () => {
    if (!live.current) return;
    clearTimeout(retry.current); retry.current = null;
    const mine = ++generation.current;
    const current = () => live.current && mine === generation.current;
    const failed = (r, reason = "unknown") => {
      if (!current()) return;
      setError(r.code === "backpressure" ? "busy" : reason);
      if (r.code === "backpressure") {
        const seconds = Number(r.retryAfter);
        retry.current = setTimeout(() => { if (current()) void load(); },
          (Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.min(300, seconds)) : 10) * 1000);
      }
    };
    setError(null); setW(null); setAskable(null);
    try {
      const [r, cat] = await Promise.all([c.welcome(), typeof c.catalog === "function" ? c.catalog() : Promise.resolve(null)]);
      if (!current()) return;
      if (!r.ok) { failed(r); return; }
      if (cat && !cat.ok && (r.mode === "legacy" || r.chat?.state === "allow")) { failed(cat, "catalogUnavailable"); return; }
      setW(r); setAskable(cat && Array.isArray(cat.askable) ? cat.askable.length : null);
    } catch { failed({ code: "unreachable" }); }
  };
  useEffect(() => { live.current = true; void load(); return () => {
    live.current = false; generation.current++; clearTimeout(retry.current);
  }; }, []);
  const refresh = async () => { const r = await c.welcome(); if (live.current && r.ok) setW(r); };
  // Hub UX U2 (spec 1.2): an administrator, while no Fleet is connected to this Hub, sees 「讓同仁加入」 here — never the
  // "your Hub admin pairs fleets for you" line. An older panel passes no `admin`: the person view, as before.
  const companyJoin = Array.isArray(features) && features.includes("company-join-v1");
  const [hubEmpty, setHubEmpty] = useState(false);
  // #3698 r1 (Fable): the session's company-join-v1 says joining is composed, not that it is switched on. The sentence follows the
  // switch as a Fleet sees it — the public metadata's features — and until that says on (or on an older client), the earlier line.
  const [joinOn, setJoinOn] = useState(false);
  useEffect(() => {
    if (!companyJoin || typeof c.joinMetadata !== "function") return;
    c.joinMetadata().then((r) => { if (live.current) setJoinOn(!!r && r.ok === true && Array.isArray(r.features) && r.features.includes("company-join-v1")); }, () => {});
  }, [companyJoin]);
  useEffect(() => {
    if (!admin || !companyJoin || typeof c.adminOverview !== "function") return;
    c.adminOverview().then((r) => { if (live.current && r && r.ok) setHubEmpty(!(r.fleets || []).some((f) => f.status === "active")); }, () => {});
  }, [admin, companyJoin]);
  // The chats' panel header already names the page ("Chats"): the welcome greets in its lead, not with a second title
  // stacked under the first (Argon #7). The Hub's name stays beside the greeting.
  const head = html`<p class="s-page-lead hub-page-lead hub-welcome-lead"><strong>${hg("welcomeTitle", name || "")}</strong>${hubName() ? html` <span class="s-scope">${hubName()}</span>` : null}<br />${hg("welcomeLead")}</p>`;
  if (error) return html`<div class="col hub-welcome-page">${head}${error === "busy"
    ? html`<p class="note" role="status" data-welcome="busy">${hr("busy")}</p>`
    : html`<${ErrorState} message=${error === "catalogUnavailable" ? hr(error) : hg(error)} onRetry=${load} />`}</div>`;
  if (!w) return html`<div class="col hub-welcome-page">${head}<div class="hub-welcome"><section class="card"><${Skeleton} variant="rows" lines=${3} /></section><section class="card"><${Skeleton} variant="rows" lines=${3} /></section></div></div>`;
  const legacy = w.mode === "legacy";
  const chat = w.chat || {}, connect = w.connect || {};
  const chatOk = legacy || chat.state === "allow", connectOk = !legacy && connect.state === "allow";
  const fleets = Array.isArray(connect.fleets) ? connect.fleets : [], max = Number(connect.maxFleets) || 0;
  const quickOn = quick && c.quickPairingV1;
  const used = fleets.filter((f) => f.status !== "revoked").length;
  const atLimit = connectOk && max > 0 && used >= max;
  const noActions = !legacy && chat.state !== "allow" && connect.state !== "allow" && chat.state !== "unknown" && connect.state !== "unknown";
  const unknown = !legacy && (chat.state === "unknown" || connect.state === "unknown");
  return html`<div class="col hub-welcome-page">${head}
    ${noActions ? html`<p class="note" role="status" data-welcome="no-actions">${hg("noActions")} ${hg("contactAdmin")}</p>` : null}
    ${unknown ? html`<p class="note" role="status" data-welcome="unknown">${hg("unknown")} <button type="button" class="btn btn-sm" onClick=${load}>${hg("retry")}</button></p>` : null}
    <div class="hub-welcome">
      <section class=${`card hub-welcome-card${chatOk ? "" : " is-off"}`} data-entry="chat" aria-disabled=${chatOk ? "false" : "true"}>
        <h3>${hg("chatTitle")}</h3><p class="note">${hg("chatHint")}</p>
        ${chatOk ? (askable === 0
            // Nothing shared with this person yet: say so — no button that opens an empty list (Argon #6).
            ? html`<p class="note" data-welcome="nothing-shared">${hg("chatNone")}</p>`
            : html`<div class="hub-welcome-actions"><button type="button" class="btn btn-primary" onClick=${onChats}>${hg("chatGo")}</button></div>`)
          : html`<p class="note">${reasonText(chat, "contactAdmin")}</p>`}
      </section>
      <section class=${`card hub-welcome-card${connectOk ? "" : " is-off"}`} data-entry="connect" aria-disabled=${connectOk ? "false" : "true"}>
        <h3>${hg("connectTitle")}</h3><p class="note">${hg("connectHint")}</p>
        ${connectOk && max > 0 ? html`<p class="note" data-welcome="fleets">${hg("connectFleets", used, max)}</p>` : null}
        ${fleets.length ? html`<ul class="hub-welcome-fleets">${fleets.map((f) => html`<li key=${f.id}><span class="hub-fp-full">${f.label || f.id}</span> <span class=${`tag${f.status === "active" ? " ok" : f.status === "suspended" || f.status === "unknown" ? " warn" : ""}`} data-fleet-status=${f.status}>${hg(FLEET_STATUS[f.status] || "fleetUnknown")}</span>
          ${quickOn ? html`<${OwnedFleetRevoke} fleet=${f} onRevoked=${load} />` : null}</li>`)}</ul>` : null}
        ${!legacy && !connectOk ? html`<p class="note">${chat.state === "allow" && connect.reason === "no-group" ? hg("connectNotIncluded") : reasonText(connect, "contactAdmin")}</p>`
          : atLimit ? html`<p class="note" data-welcome="limit">${hg("connectLimit")}</p>`
          // Spec 1.2: the primary text is step 3's sentence (company join on this Hub); without it, the pairing-code line as before —
          // never to an administrator.
          : companyJoin && joinOn && joinSentence(location.origin) ? html`<p class="note hub-join-sentence" data-welcome="sentence">${joinSentence(location.origin)}</p>`
          : !admin && (legacy || !quickOn) ? html`<p class="note">${hg("connectManual")}</p>` : null}
        ${quickOn ? html`<details class="s-ui-disclosure hub-welcome-other"><summary>${otherWaysLabel()}</summary><div class="s-disclosure-body">
          <${QuickPairingGuide} allowed=${connectOk && !atLimit} publishAllowed=${w.publish?.state === "allow"} onConnected=${refresh} /></div></details>` : null}
      </section>
    </div>
    ${!legacy && w.publish && w.publish.state !== "allow" && connectOk ? html`<p class="note" data-welcome="publish">${hg("publishNot")}</p>` : null}
    ${admin && companyJoin && hubEmpty ? html`<div class="hub-welcome-admin"><${CompanyJoinAdminCard} entry=${true} groups=${true} /></div>` : null}
  </div>`;
}
