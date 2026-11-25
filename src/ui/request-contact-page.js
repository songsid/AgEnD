// M-3736 J (S-228): Fleet → Authorizations once the same-card host is installed (request-contact-client.js decides; until
// then contact-authorizations.js keeps today's page). The server scopes the list to the requests this session's person
// may manage (32 a page, then a cursor); the page sends no person, only an agent and a status.
// - Show: waiting (default) or all; one agent. ?ticket=<id> opens that request at the top (Needs you, a chat badge).
// - Each request is the one card (request-contact-card.js). It reads again on the stream's contact-auth frame and when the
//   page is shown again (no timer); a cursor the server refused (its role snapshot changed) starts the list again.
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { Skeleton, ErrorState, Empty } from "/assets/ui-states.js";
import { labelOf } from "/assets/instance-nav.js";
import { ca } from "./contact-auth-strings.js";
import { RequestContactCard } from "./request-contact-card.js";
import { getCard, listCards, RC_ID } from "./request-contact-client.js";

register("rcpage", {
  en: { lead: "Contact requests between agents that wait for an admin, and what was decided.", forbidden: "You don't manage the agents these requests are for.",
    signIn: "Sign in to see contact requests.", unavailable: "Contact requests are unavailable right now. Try again in a moment.", failed: "Couldn't load contact requests.", retry: "Try again" },
  "zh-TW": { lead: "Agent 之間等待管理員處理的聯絡申請，以及處理結果。", forbidden: "你沒有管理這些申請所屬的 Agent。",
    signIn: "請登入後查看聯絡申請。", unavailable: "目前無法取得聯絡申請，請稍後再試。", failed: "無法載入聯絡申請。", retry: "重試" },
});
const tp = (k, ...a) => t(`rcpage.${k}`, ...a);
/** Why the requests can't be shown (the host's answer was a refusal or a failure), with Try again. */
export function SameCardUnknown({ code, onRetry }) {
  const said = code === "sign-in-required" ? tp("signIn") : code === "forbidden" ? tp("forbidden") : code === "unavailable" ? tp("unavailable") : tp("failed");
  return html`<div class="rc-unknown" data-code=${code || "failed"}><p class="note">${said}</p>
    ${code === "sign-in-required" || code === "forbidden" ? null : html`<button type="button" class="btn btn-sm" onClick=${onRetry}>${tp("retry")}</button>`}</div>`;
}
const ticketFromSearch = () => { try { const v = new URLSearchParams(location.search).get("ticket"); return v && RC_ID.test(v) ? v : null; } catch { return null; } };

export function RequestContactAuthorizations() {
  const { instances } = useStore(appStore);
  const [status, setStatus] = useState("pending");
  const [agent, setAgent] = useState("");
  const [page, setPage] = useState({ loading: true, items: [], next: null });
  const [focus, setFocus] = useState(null);
  const focusId = ticketFromSearch();
  const filters = { status: status === "pending" ? "pending" : "all", ...(agent ? { agent } : {}) };
  const read = async (cursor) => {
    const r = await listCards({ ...filters, ...(cursor ? { cursor } : {}) });
    if (!r.ok) {
      if (cursor && r.status === 409) { void read(); return; }                    // the cursor's snapshot changed: from the top
      setPage((p) => ({ ...p, loading: false, error: r.code })); return;
    }
    const items = Array.isArray(r.data.items) ? r.data.items : [];
    setPage((p) => ({ loading: false, items: cursor ? [...p.items, ...items] : items, next: r.data.nextCursor || null }));
  };
  const readFocus = async () => { if (!focusId) return; const r = await getCard(focusId); setFocus(r.ok ? r.data : null); };
  const key = JSON.stringify(filters);
  useEffect(() => {
    setPage({ loading: true, items: [], next: null });
    void read(); void readFocus();
    const sub = appStore.get().streamOn;
    const off = typeof sub === "function" ? sub("contact-auth", () => { void read(); void readFocus(); }) : null;
    const onShow = () => { if (document.visibilityState === "visible") { void read(); void readFocus(); } };
    document.addEventListener("visibilitychange", onShow);
    return () => { if (typeof off === "function") off(); document.removeEventListener("visibilitychange", onShow); };
  }, [key, focusId]);
  const replace = (c) => { setPage((p) => ({ ...p, items: p.items.map((x) => (x.ticket.id === c.ticket.id ? c : x)) })); if (focus && focus.ticket.id === c.ticket.id) setFocus(c); };
  const names = (instances || []).map((i) => i.name).filter(Boolean).sort();
  const list = page.items.filter((x) => !focus || x.ticket.id !== focus.ticket.id);
  return html`<div class="contact-auth-page rc-page">
    <p class="s-page-lead">${tp("lead")}</p>
    <div class="us-bar-top contact-filters">
      <div class="seg-inline" role="group" aria-label=${ca("filterStatus")}>${["pending", "all"].map((s) => html`<button key=${s} type="button" class=${`btn btn-sm${status === s ? " btn-primary" : ""}`}
          aria-pressed=${status === s ? "true" : "false"} onClick=${() => setStatus(s)}>${ca(`filter_${s}`)}</button>`)}</div>
      <label class="us-group contact-agent-filter"><span>${ca("filterAgent")}</span><select value=${agent} onChange=${(e) => setAgent(e.currentTarget.value)}>
        <option value="">${ca("filterAny")}</option>${names.map((n) => html`<option key=${n} value=${n}>${labelOf((instances || []).find((i) => i.name === n))}</option>`)}</select></label>
    </div>
    ${focus ? html`<${RequestContactCard} key=${`f:${focus.ticket.id}`} card=${focus} focus=${true} onChange=${replace} />` : null}
    ${page.loading ? html`<${Skeleton} variant="cards" lines=${2} label=${ca("loading")} />`
      : page.error && !page.items.length ? (page.error === "forbidden" ? html`<p class="note">${tp("forbidden")}</p>`
        : html`<${ErrorState} message=${ca(page.error === "unavailable" ? "unavailable" : "loadFailed")} onRetry=${() => void read()} />`)
      : !list.length && !focus ? html`<${Empty} icon="key" title=${ca(status === "pending" ? "emptyPending" : "empty")} action=${status === "pending" ? html`<button type="button" class="btn btn-sm" onClick=${() => setStatus("all")}>${ca("viewAll")}</button>` : null} />`
      : html`<div class="contact-ticket-list">${list.map((c) => html`<${RequestContactCard} key=${c.ticket.id} card=${c} onChange=${replace} />`)}</div>`}
    ${page.next ? html`<div class="field-row"><button type="button" class="btn btn-sm" onClick=${() => void read(page.next)}>${ca("more")}</button></div>` : null}
  </div>`;
}
