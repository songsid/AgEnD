// #3298 S-89: the signed-in welcome on a Hub with group permissions — two large entries, "Chat with an agent" and "Connect your
// fleet", shaped by what this person may do now (no actions / ask only / full). It is a DISPLAY of the server's welcome
// projection (GET /hub/v1/me/welcome): it grants nothing, and every chat, pairing or sharing action asks the server again.
// An answer the directory couldn't give is "can't be checked right now" with Retry, never a cached yes. Shared components:
// PageHead, card, btn, tag, note, Skeleton/ErrorState; the two cards sit in .hub-welcome (hub.css: a two-up grid, one column
// on a phone).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { PageHead } from "/assets/page-head.js";
import { ErrorState, Skeleton } from "/assets/ui-states.js";
import { navigate } from "/assets/app-nav.js";
import { hubClient, hubName } from "./hub-client.js";
import { hg } from "./hub-group-strings.js";

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
export function HubWelcome({ name, onChats = () => navigate("/ui/hub?chats=1") }) {
  const c = hubClient();
  const [w, setW] = useState(null), [askable, setAskable] = useState(null), [error, setError] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const load = async () => {
    setError(false); setW(null);
    const [r, cat] = await Promise.all([c.welcome(), typeof c.catalog === "function" ? c.catalog() : Promise.resolve(null)]);
    if (!live.current) return;
    if (!r.ok) { setError(true); return; }
    setW(r); setAskable(cat && cat.ok && Array.isArray(cat.askable) ? cat.askable.length : null);
  };
  useEffect(() => { void load(); }, []);
  const head = html`<${PageHead} title=${hg("welcomeTitle", name || "")} scope=${hubName() || "Hub"} lead=${hg("welcomeLead")} />`;
  if (error) return html`<div class="col hub-welcome-page">${head}<${ErrorState} message=${hg("unknown")} onRetry=${load} /></div>`;
  if (!w) return html`<div class="col hub-welcome-page">${head}<div class="hub-welcome"><section class="card"><${Skeleton} variant="rows" lines=${3} /></section><section class="card"><${Skeleton} variant="rows" lines=${3} /></section></div></div>`;
  const legacy = w.mode === "legacy";
  const chat = w.chat || {}, connect = w.connect || {};
  const chatOk = legacy || chat.state === "allow", connectOk = !legacy && connect.state === "allow";
  const fleets = Array.isArray(connect.fleets) ? connect.fleets : [], max = Number(connect.maxFleets) || 0;
  const atLimit = connectOk && max > 0 && fleets.filter((f) => f.status !== "revoked").length >= max;
  const noActions = !legacy && chat.state !== "allow" && connect.state !== "allow" && chat.state !== "unknown" && connect.state !== "unknown";
  const unknown = !legacy && (chat.state === "unknown" || connect.state === "unknown");
  return html`<div class="col hub-welcome-page">${head}
    ${noActions ? html`<p class="note" role="status" data-welcome="no-actions">${hg("noActions")} ${hg("contactAdmin")}</p>` : null}
    ${unknown ? html`<p class="note" role="status" data-welcome="unknown">${hg("unknown")} <button type="button" class="btn btn-sm" onClick=${load}>${hg("retry")}</button></p>` : null}
    <div class="hub-welcome">
      <section class=${`card hub-welcome-card${chatOk ? "" : " is-off"}`} data-entry="chat" aria-disabled=${chatOk ? "false" : "true"}>
        <h3>${hg("chatTitle")}</h3><p class="note">${hg("chatHint")}</p>
        ${chatOk ? html`${askable === 0 ? html`<p class="note" data-welcome="nothing-shared">${hg("chatNone")}</p>` : null}
            <div class="hub-welcome-actions"><button type="button" class="btn btn-primary" onClick=${onChats}>${hg("chatGo")}</button></div>`
          : html`<p class="note">${reasonText(chat, "contactAdmin")}</p>`}
      </section>
      <section class=${`card hub-welcome-card${connectOk ? "" : " is-off"}`} data-entry="connect" aria-disabled=${connectOk ? "false" : "true"}>
        <h3>${hg("connectTitle")}</h3><p class="note">${hg("connectHint")}</p>
        ${connectOk && max > 0 ? html`<p class="note" data-welcome="fleets">${hg("connectFleets", fleets.filter((f) => f.status !== "revoked").length, max)}</p>` : null}
        ${fleets.length ? html`<ul class="hub-welcome-fleets">${fleets.map((f) => html`<li key=${f.id}>${f.label || f.id} <span class=${`tag${f.status === "active" ? " ok" : ""}`}>${f.status}</span></li>`)}</ul>` : null}
        ${legacy ? html`<p class="note">${hg("connectManual")}</p>`
          : !connectOk ? html`<p class="note">${chat.state === "allow" && connect.reason === "no-group" ? hg("connectNotIncluded") : reasonText(connect, "contactAdmin")}</p>`
          : atLimit ? html`<p class="note" data-welcome="limit">${hg("connectLimit")}</p>`
          : html`<p class="note">${hg("connectManual")}</p>`}
      </section>
    </div>
    ${!legacy && w.publish && w.publish.state !== "allow" && connectOk ? html`<p class="note" data-welcome="publish">${hg("publishNot")}</p>` : null}
  </div>`;
}
