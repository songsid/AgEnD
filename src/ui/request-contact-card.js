// M-3736 J (S-228; design #4456 §6, slice I's V1 contract: docs/design/request-contact-same-card-api.md): the one contact
// card — the same card in Fleet → Authorizations and Needs you, for every managing admin who may read it.
// - What it is: the sending Agent → the exact target, who asked (the recorded initiating person, never the approver), how
//   it came in, the message, where replies go, the reason, when it expires; a continued request says so and has no actions.
// - Continue (approve once) / Always allow… / Decline. Continue states its D1 scope (a root request: this request and its
//   later Agent contacts, nothing else); a legacy ticket keeps its old one-request wording.
// - Not verified yet: the same card, with Authorize this browser inline. A press then only marks the choice; nothing is
//   decided. Once this browser is verified the card is read again: still waiting → the marked choice, focus left where it
//   was, and the person presses it (or another) to decide. Changed meanwhile → its outcome, in place. A decision is only
//   ever sent from a click on a decision button: never from an effect, a poll, a key or the authorization's completion.
// - 409 (decided or changed elsewhere) → read the same card again and show it; never retried.
// A module of its own, with its own words (the module-skew rule): an older cached page keeps today's cards.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { toast } from "/assets/ui-toast.js";
import { dateTimeText } from "/assets/clock-text.js";
import { AuthorizeChip, useWebAuthorization, resetWebAuthorization } from "/assets/web-authorize.js";
import { detailsPath } from "/assets/app-route.js";
import { ca } from "./contact-auth-strings.js";
import { ContactGrantEditor } from "./contact-grant-editor.js";
import { decideCard, getCard, RC_REREAD } from "./request-contact-client.js";

register("rcard", {
  en: {
    continue: "Continue (approve once)", alwaysAllow: "Always allow…", approveOnce: "Approve once", decline: "Decline",
    scopeRoot: "Continue this request and its later Agent contacts. This does not approve what Agents do or authorize unrelated requests.",
    scopeOperation: "Approve = forward this request once.",
    askedBy: "Asked by {0}", askedByNone: "No single known person asked", unknownPerson: "Unknown person", hubPerson: "{0} (Hub)",
    ingress_owner: "An admin's request", "ingress_free-room": "Free room", "ingress_restricted-room": "Restricted room", ingress_guest: "Guest", ingress_hub: "Hub",
    repliesTo: "Replies go back to {0}.", audience_room: "the original room", audience_web: "the web conversation", audience_hub: "the Hub conversation", audience_instance: "the requesting Agent",
    "reason_restricted-room-request": "This was sent while {0} was working on {1}'s request from a restricted room.",
    "reason_guest-request": "This was sent while {0} was working on a request from {1}, a guest.",
    "reason_hub-request": "This was sent while {0} was working on {1}'s request from the Hub.",
    "reason_unproved-recovery": "{0} resumed work whose requester couldn't be proven, so this contact needs approval.",
    reason_other: "This contact needs an admin's approval.", someone: "someone",
    grantView: "View allowed contacts in Permissions",
    waiting: "Waiting for your Confirm in Discord or Telegram ({0})",
    continuedFrom: "Continued from request #{0}: it needs no decision here.",
    state_approved_root: "Continued",
    verifyTitle: "Authorize this browser to decide.", verifyBody: "You can read this request now. Choose below, then authorize this browser: the request stays here, and nothing is decided until you press your choice again.",
    chosen: "Your choice: {0}. Authorize this browser to finish.", chosenReady: "This browser is verified. Your choice is marked: press it to finish, or choose another.",
    changed: "This request changed while you were authorizing. Here it is now.",
    decidedElsewhere: "This request was decided elsewhere. Here is its outcome.",
    failed: "Couldn't record the decision: {0}", forbidden: "You can't decide this request.", signIn: "Sign in again to decide.",
    unavailable: "Contact approvals are unavailable right now.", grantInvalid: "That allowed contact can't be saved; approve once or decline.",
    noGrant: "This request's person can't become an allowed contact; Continue or Decline it.",
    decidedAt: "Decided {0}",
  },
  "zh-TW": {
    continue: "繼續（核准這次）", alwaysAllow: "一律允許…", approveOnce: "核准這一次", decline: "拒絕",
    scopeRoot: "繼續這筆請求及它後續的 Agent 聯絡；這不代表核准 Agent 的操作，也不會授權其他請求。",
    scopeOperation: "核准＝只轉交這一次。",
    askedBy: "由 {0} 提出", askedByNone: "不是由單一已知的人提出", unknownPerson: "身分不明", hubPerson: "{0}（Hub）",
    ingress_owner: "管理員的請求", "ingress_free-room": "自由模式房間", "ingress_restricted-room": "受限模式房間", ingress_guest: "訪客", ingress_hub: "Hub",
    repliesTo: "回覆會回到{0}。", audience_room: "原本的房間", audience_web: "網頁對話", audience_hub: "Hub 對話", audience_instance: "提出請求的 Agent",
    "reason_restricted-room-request": "這是 {0} 處理 {1} 在受限模式房間提出的請求時送出的。",
    "reason_guest-request": "這是 {0} 處理訪客 {1} 的請求時送出的。",
    "reason_hub-request": "這是 {0} 處理 {1} 從 Hub 提出的請求時送出的。",
    "reason_unproved-recovery": "{0} 接續的工作無法證明是誰提出的，因此這次聯絡需要核准。",
    reason_other: "這次聯絡需要管理員核准。", someone: "某人",
    grantView: "在「權限」查看允許的聯絡",
    waiting: "等你在 Discord 或 Telegram 按下確認（{0}）",
    continuedFrom: "接續申請 #{0}：這裡不需要再決定。",
    state_approved_root: "已繼續",
    verifyTitle: "授權這個瀏覽器後才能決定。", verifyBody: "你現在就能看這筆申請。先在下方選擇，再授權這個瀏覽器：申請會留在這裡，你再按一次選擇之前，什麼都不會決定。",
    chosen: "你的選擇：{0}。授權這個瀏覽器即可完成。", chosenReady: "這個瀏覽器已驗證。你的選擇已標出：按下它即可完成，或改選其他。",
    changed: "你授權期間這筆申請有變動，以下是目前狀態。",
    decidedElsewhere: "這筆申請已在別處處理，以下是結果。",
    failed: "無法記錄決定：{0}", forbidden: "你無法決定這筆申請。", signIn: "請重新登入後再決定。",
    unavailable: "目前無法處理聯絡核准。", grantInvalid: "無法儲存這項允許的聯絡；請核准這次或拒絕。",
    noGrant: "這筆申請的提出者無法設為允許的聯絡；請繼續或拒絕。",
    decidedAt: "{0} 已處理",
  },
});
const tr = (k, ...a) => t(`rcard.${k}`, ...a);
const when = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? dateTimeText(d, { dateStyle: "medium", timeStyle: "short" }, []) : ""; };
const TONE = { pending: "warn", approved: "ok", delivered: "ok", declined: "bad", expired: "muted", unknown: "bad" };
const stateOf = (s) => (Object.prototype.hasOwnProperty.call(TONE, s) ? s : "unknown");
const VERBS = new Set(["send_to_instance", "delegate_task", "request_information", "broadcast", "report_result"]);
const INGRESS = new Set(["owner", "free-room", "restricted-room", "guest", "hub"]);
const AUDIENCE = new Set(["room", "web", "hub", "instance"]);
const shortId = (id) => { const s = String(id || ""); return /^R[a-f0-9]{8}-/.test(s) ? s.slice(0, 9) : s; };

/** The person's name alone: a verified display name, else their identity; never invented (null: "someone"). */
export function requesterName(actor) {
  if (!actor || actor.kind === "unknown") return tr("someone");
  if (actor.platform === "hub") return tr("hubPerson", actor.displayName || actor.id);
  if (actor.platform === "host") return ca("operator");
  return actor.displayName || actor.userId;
}
/** The card's reason (a stable code, Sentinel #4492): the legacy two in today's words, the scoped ones with who and which Agent. */
export function reasonText(card) {
  const code = String(card.reason || "");
  if (code === "earlier-non-admin" || code === "unknown-origin") return ca(`request_reason_${code}`, card.sourceLabel);
  // From the Hub, the sentence already says so: the name alone, not "(Hub)" twice.
  const hubName = code === "hub-request" && card.requester && card.requester.platform === "hub" ? card.requester.displayName || card.requester.id : null;
  if (["restricted-room-request", "guest-request", "hub-request"].includes(code)) return tr(`reason_${code}`, card.sourceLabel, hubName || requesterName(card.requester));
  if (code === "unproved-recovery") return tr("reason_unproved-recovery", card.sourceLabel);
  return tr("reason_other");
}
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** Who asked, in words: the recorded initiating actor (request-context-protocol.ts's shape), never an invented person. */
export function requesterText(actor) {
  if (!actor) return tr("askedByNone");
  if (actor.kind === "unknown") return tr("askedBy", tr("unknownPerson"));
  if (actor.platform === "hub") return tr("askedBy", tr("hubPerson", actor.displayName || actor.id));
  if (actor.platform === "host") return tr("askedBy", ca("operator"));
  return tr("askedBy", actor.displayName || actor.userId);
}

/**
 * The choice each ticket's person made before this browser was verified, for this page load only: a re-sign-in (as
 * anyone) is a new page load and starts with none. Keyed by ticket id and the revision it was made on.
 */
const retained = new Map();
export function retainedChoice(card) {
  const r = card && retained.get(card.ticket.id);
  return r && r.revision === card.snapshot.ticketRevision ? r.choice : null;
}
export function forgetChoices() { retained.clear(); }

/**
 * Authorize this browser, from the card's own reading of it (so the card itself sees pending turn into verified): the
 * button where this browser can ask, the countdown while the account's Confirm waits, and otherwise the shared line, which
 * says why this browser can't be authorized here. Asking only asks for the browser's authorization; it decides nothing.
 */
function authorizeControl(auth) {
  const st = auth.st;
  if (!st) return null;
  if (st.state === "pending") return html`<p class="note rc-auth-wait" role="status">${tr("waiting", mmss(auth.left))}${auth.notice ? html` · ${auth.notice}` : null}</p>`;
  if (st.reason === "not_authorized" || st.reason === "authorization_expired") {
    return html`<div class="rc-auth"><button type="button" class="btn btn-sm rc-auth-ask" onClick=${auth.ask}>${t("webauth.authorize")}</button>${auth.notice ? html` <span class="note" role="status">${auth.notice}</span>` : null}</div>`;
  }
  return html`<${AuthorizeChip} />`;
}

/** One card. `onChange(card)`: the server's fresh card after a decision or a re-read. */
export function RequestContactCard({ card, onChange, focus = false }) {
  const [busy, setBusy] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [granted, setGranted] = useState(false);
  const [choice, setChoice] = useState(() => retainedChoice(card));
  const auth = useWebAuthorization();
  const tk = card.ticket, st = stateOf(tk.state);
  const root = card.approvalScope === "root-request";
  const open = st === "pending" && !card.continuedFrom;
  const needsVerify = open && card.actions.requiresVerification;
  const canDecide = open && card.actions.canDecide && !card.actions.requiresVerification;
  const grantable = card.actions.canGrant && Array.isArray(card.grantCandidates) && card.grantCandidates.length > 0;
  const shown = useRef(card.snapshot.ticketRevision);

  // Once this browser is verified, read the same card again (only reading: a decision waits for a click).
  const verified = auth.st && auth.st.state === "verified";
  useEffect(() => {
    if (!needsVerify || !verified) return undefined;
    let live = true;
    void getCard(tk.id).then((r) => {
      if (!live || !r.ok) return;
      if (r.data.snapshot.ticketRevision !== shown.current || stateOf(r.data.ticket.state) !== "pending") { retained.delete(tk.id); setChoice(null); toast(tr("changed"), false); }
      onChange?.(r.data);
    });
    return () => { live = false; };
  }, [needsVerify, verified, tk.id]);
  useEffect(() => { shown.current = card.snapshot.ticketRevision; }, [card.snapshot.ticketRevision]);

  const reread = async (say) => {
    const again = await getCard(tk.id);
    retained.delete(tk.id); setChoice(null);
    if (say) toast(say, false);
    if (again.ok) onChange?.(again.data);
  };
  const decide = async (decision, grant) => {
    if (busy) return false;
    setBusy(true);
    const r = await decideCard(card, decision, grant);
    setBusy(false);
    if (r.ok) { retained.delete(tk.id); setChoice(null); if (grant) { setGranted(true); toast(ca("grantSaved"), true); } onChange?.(r.data); return true; }
    if (r.status === 409 || RC_REREAD.has(r.code)) { await reread(tr("decidedElsewhere")); return false; }
    if (r.code === "verification-required") { resetWebAuthorization(); await reread(null); return false; }
    toast(r.code === "forbidden" ? tr("forbidden") : r.code === "sign-in-required" ? tr("signIn") : r.code === "unavailable" ? tr("unavailable")
      : r.code === "invalid-grant" ? tr("grantInvalid") : tr("failed", r.code), false);
    return false;
  };
  // A press: before verification it only marks the choice; after, it decides (Always allow opens its rule first).
  const press = (which) => {
    if (needsVerify) { retained.set(tk.id, { choice: which, revision: card.snapshot.ticketRevision }); setChoice(which); return; }
    if (!canDecide) return;
    if (which === "always") { setGrantOpen(true); return; }
    void decide(which === "decline" ? "decline" : "approve-once");
  };
  const label = (which) => (which === "continue" ? (root ? tr("continue") : tr("approveOnce")) : which === "always" ? tr("alwaysAllow") : tr("decline"));
  const stateText = st === "approved" && root ? tr("state_approved_root") : ca(`state_${st}`);
  const people = (card.grantCandidates || []).map((c) => ({ key: c.key, label: c.label, platform: c.platform }));
  const button = (which, cls) => html`<button type="button" class=${`btn btn-sm${cls}${choice === which ? " rc-chosen" : ""}`} aria-pressed=${needsVerify || choice ? (choice === which ? "true" : "false") : undefined}
    disabled=${busy || (which === "always" && !grantable)} data-choice=${which} onClick=${() => press(which)}>${label(which)}</button>`;

  return html`<article class=${`card contact-ticket rc-card${st === "pending" || focus ? " lbar" : ""}${focus ? " focus" : ""}`} data-ticket=${tk.id} data-state=${st} data-engine=${card.engine}>
    <div class="contact-ticket-head"><strong>${ca("ticketTitle")}</strong><code class="contact-ticket-id" title=${tk.id}>#${shortId(tk.id)}</code>
      ${VERBS.has(tk.verb) ? html`<span class="tag contact-ticket-verb">${ca(`verb_${tk.verb}`)}</span>` : null}
      <span class=${`tag contact-ticket-state${TONE[st] === "warn" ? " warn" : TONE[st] === "ok" ? " s-state ok" : TONE[st] === "bad" ? " s-state bad" : ""}`}>${stateText}</span></div>
    <div class="contact-ticket-meta">
      <div class="contact-ticket-route"><span>${ca("from", "")}</span><span class="contact-agent-chip" title=${tk.source}>${card.sourceLabel}</span>
        <span>→ ${ca("to", "")}</span><span class="contact-agent-chip" title=${tk.target}>${card.targetLabel}</span></div>
      <div class="contact-ticket-origin rc-requester"><span>${requesterText(card.requester)}</span>
        ${INGRESS.has(card.ingress) ? html`<span class="tag rc-ingress" data-ingress=${card.ingress}>${tr(`ingress_${card.ingress}`)}</span>` : null}</div>
    </div>
    ${tk.message ? html`<div class="contact-ticket-message-box"><p class="contact-ticket-label">${ca("messageLabel")}</p><pre class="contact-ticket-message">${tk.message}</pre></div>` : null}
    ${card.reason ? html`<p class="note contact-reason rc-reason" data-reason=${card.reason}>${reasonText(card)}</p>` : null}
    ${card.returnAudience && AUDIENCE.has(card.returnAudience.kind) ? html`<p class="note rc-return">${tr("repliesTo", tr(`audience_${card.returnAudience.kind}`))}</p>` : null}
    ${card.continuedFrom ? html`<p class="note rc-continued">${tr("continuedFrom", shortId(card.continuedFrom))}</p>` : null}
    <div class="contact-ticket-foot">
      <div class="contact-ticket-times"><span class="contact-time-item">${ca("created", when(tk.createdAt))}</span>
        <span class="contact-time-item">${tk.decidedAt ? tr("decidedAt", when(tk.decidedAt)) : ca("expires", when(tk.expiresAt))}</span></div>
      ${st === "delivered" ? html`<p class="note">${ca("deliveryNote")}</p>` : null}
    </div>
    ${granted ? html`<p><a class="st-link rc-grant-view" href=${`${detailsPath(tk.target)}?cat=permissions`}>${tr("grantView")}</a></p>` : null}
    ${open && (canDecide || needsVerify) ? html`<div class="contact-decide rc-decide">
      ${needsVerify ? html`<div class="rc-verify" role="group" aria-label=${tr("verifyTitle")}><p class="rc-verify-title"><strong>${tr("verifyTitle")}</strong></p>
        <p class="note">${choice ? tr("chosen", label(choice)) : tr("verifyBody")}</p>${authorizeControl(auth)}</div>`
        : choice ? html`<p class="note rc-ready" role="status">${tr("chosenReady")}</p>` : null}
      <p class="note contact-decided-note rc-scope" data-scope=${card.approvalScope}>${root ? tr("scopeRoot") : tr("scopeOperation")}</p>
      <div class="contact-decide-controls">${button("continue", " btn-primary")}${button("always", "")}${button("decline", " danger")}</div>
      ${!grantable ? html`<p class="note rc-no-grant">${tr("noGrant")}</p>` : null}
      ${grantOpen && grantable && canDecide ? html`<${ContactGrantEditor} key=${`${tk.id}:${card.snapshot.ticketRevision}`} people=${people} keyOf=${(p) => p.key}
        source=${card.sourceLabel} target=${card.targetLabel} verb=${tk.verb}
        onClose=${() => setGrantOpen(false)} onSave=${(c) => decide("approve-once", { expiresAt: c.expiresAt, remainingUses: c.remainingUses, personKeys: c.personKeys })} />` : null}
    </div>` : null}
  </article>`;
}
