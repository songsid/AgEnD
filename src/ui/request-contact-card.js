// M-3736 J (S-228; design #4456 §6, slice I's V1 contract: docs/design/request-contact-same-card-api.md): the one contact
// card — the same card in Fleet → Authorizations and Needs you, for every managing admin who may read it.
// - What it is: the sending Agent → the exact target, who asked (the recorded initiating person, never the approver), how
//   it came in, the message, where replies go, the reason, when it expires; a continued request says so and has no actions.
// - Continue (with follow-ups) / Set allowed contacts… (the grant editor's own name) / Decline. Continue states its D1 scope (a root request: this request and its
//   later Agent contacts, nothing else); a legacy ticket keeps its old one-request wording.
// - Not verified yet: the same card, its buttons off, with one line and Authorize this browser inline. Once this browser
//   is verified the card is read again and shows its buttons; one click decides. Verifying never decides anything: a
//   decision is only ever sent from a click on a decision button, never from an effect, a poll, a key or the
//   authorization's completion.
// - Each card's detail line says its scope in a few words (Continue = this request and its follow-ups; Approve once = this
//   one request), so the two verbs in one list explain themselves; the long wording is in its details.
// - 409 (decided or changed elsewhere) → read the same card again and show it; never retried.
// A module of its own, with its own words (the module-skew rule): an older cached page keeps today's cards.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { toast } from "/assets/ui-toast.js";
import { dateTimeText } from "/assets/clock-text.js";
import { AuthorizeChip, useWebAuthorization, resetWebAuthorization } from "/assets/web-authorize.js";
import { detailsPath } from "/assets/app-route.js";
import { Icon } from "/assets/ui-icons.js";
import { ca } from "./contact-auth-strings.js";
import { ContactGrantEditor } from "./contact-grant-editor.js";
import { decideCard, getCard, RC_REREAD } from "./request-contact-client.js";

register("rcard", {
  en: {
    continue: "Continue (with follow-ups)", approveOnce: "Approve once", decline: "Decline",
    scopeRoot: "Continue this request and its later Agent contacts. This does not approve what Agents do or authorize unrelated requests.",
    scopeOperation: "Approve = forward this request once.",
    scopeShortRoot: "Continue = this request and its follow-up contacts only.", scopeShortOperation: "Approve once = this one request only.",
    askedBy: "Asked by {0}", askedByNone: "Can't tell who asked", unknownPerson: "Unknown person", hubPerson: "{0} (Hub)",
    ingress_owner: "An admin's request", "ingress_free-room": "Free room", "ingress_restricted-room": "Restricted room", ingress_guest: "Guest", ingress_hub: "Hub",
    repliesTo: "Replies go back to {0}.", audience_room: "the original room", audience_web: "the web conversation", audience_hub: "the Hub conversation", audience_instance: "the requesting Agent",
    "reason_restricted-room-request": "This was sent while {0} was working on {1}'s request from a restricted room.",
    "reason_guest-request": "This was sent while {0} was working on a request from {1}, a guest.",
    "reason_hub-request": "This was sent while {0} was working on {1}'s request from the Hub.",
    "reason_unproved-recovery": "{0} resumed work whose requester couldn't be proven, so this contact needs approval.",
    "reason_interrupted-launch": "This agent was interrupted; this contact needs one approval.",
    reason_other: "This contact needs an admin's approval.", someone: "someone",
    grantView: "View allowed contacts in Permissions",
    waiting: "Waiting for your Confirm in Discord or Telegram ({0})",
    continuedFrom: "Continued from request #{0}: it needs no decision here.",
    state_approved_root: "Continued", forwardedTo: "Forwarded to {0}.",
    verifyTitle: "Authorize this browser to decide.",
    decidedElsewhere: "This request was decided elsewhere. Here is its outcome.",
    uncertain: "Couldn't confirm the decision. Here is the request as it stands now; nothing was sent again.",
    failed: "Couldn't record the decision: {0}", forbidden: "You can't decide this request.", signIn: "Sign in again to decide.",
    unavailable: "Contact approvals are unavailable right now.", grantInvalid: "That allowed contact can't be saved; approve once or decline.",
    noGrant: "This request's person can't become an allowed contact; Continue or Decline it.",
    decidedAt: "Decided {0}",
    upgrade: "This request stays held until its target is upgraded.",
    readFailed: "Couldn't read this request's current state.", readRetry: "Read again",
  },
  "zh-TW": {
    continue: "繼續（含後續聯絡）", approveOnce: "核准這一次", decline: "拒絕",
    scopeRoot: "繼續這筆請求及它後續的 Agent 聯絡；這不代表核准 Agent 的操作，也不會授權其他請求。",
    scopeOperation: "核准＝只轉交這一次。",
    scopeShortRoot: "繼續＝只放行這筆請求和它後續的聯絡。", scopeShortOperation: "核准這一次＝只轉交這一筆請求。",
    askedBy: "由 {0} 提出", askedByNone: "無法確認是誰提出的", unknownPerson: "身分不明", hubPerson: "{0}（Hub）",
    ingress_owner: "管理員的請求", "ingress_free-room": "自由模式房間", "ingress_restricted-room": "受限模式房間", ingress_guest: "訪客", ingress_hub: "Hub",
    repliesTo: "回覆會回到{0}。", audience_room: "原本的房間", audience_web: "網頁對話", audience_hub: "Hub 對話", audience_instance: "提出請求的 Agent",
    "reason_restricted-room-request": "這是 {0} 處理 {1} 在受限模式房間提出的請求時送出的。",
    "reason_guest-request": "這是 {0} 處理訪客 {1} 的請求時送出的。",
    "reason_hub-request": "這是 {0} 處理 {1} 從 Hub 提出的請求時送出的。",
    "reason_unproved-recovery": "{0} 接續的工作無法證明是誰提出的，因此這次聯絡需要核准。",
    "reason_interrupted-launch": "這個 Agent 曾中斷；這次聯絡需要核准一次。",
    reason_other: "這次聯絡需要管理員核准。", someone: "某人",
    grantView: "在「權限」查看允許的聯絡",
    waiting: "等你在 Discord 或 Telegram 按下確認（{0}）",
    continuedFrom: "接續申請 #{0}：這裡不需要再決定。",
    state_approved_root: "已繼續", forwardedTo: "已轉交給 {0}。",
    verifyTitle: "授權這個瀏覽器後才能決定。",
    decidedElsewhere: "這筆申請已在別處處理，以下是結果。",
    uncertain: "無法確認這次決定是否完成。以下是這筆申請目前的狀態；沒有再次送出。",
    failed: "無法記錄決定：{0}", forbidden: "你無法決定這筆申請。", signIn: "請重新登入後再決定。",
    unavailable: "目前無法處理聯絡核准。", grantInvalid: "無法儲存這項允許的聯絡；請核准這次或拒絕。",
    noGrant: "這筆申請的提出者無法設為允許的聯絡；請繼續或拒絕。",
    decidedAt: "{0} 已處理",
    upgrade: "這份申請會繼續保留，等接收端升級後才能處理。",
    readFailed: "無法讀取這筆申請目前的狀態。", readRetry: "重新讀取",
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
  // S-249 (Sentinel H, #4500): a launch cut off mid-request; its requester stays unknown and it offers no grant (canGrant).
  if (code === "interrupted-launch") return tr("reason_interrupted-launch");
  return tr("reason_other");
}
/**
 * The card's server-owned candidates as people any copy of the grant editor keys the same way (#4497 review): the
 * server's key is JSON [platform, userId], so each carries the userId its key names — an older cached editor, which keys
 * by [platform, userId] and knows no `keyOf`, still selects exactly these keys.
 */
export function candidatePeople(card) {
  return (card.grantCandidates || []).map((c) => ({ key: c.key, label: c.label, platform: c.platform, userId: candidateUserId(c) }));
}
/** Save control: the rule to send, only for keys this card offered (at least one, never one an editor made up); else null. */
export function grantFromChoice(card, c) {
  const offered = new Set((card.grantCandidates || []).map((x) => x.key));
  const keys = Array.isArray(c && c.personKeys) ? c.personKeys : [];
  if (!keys.length || !keys.every((k) => typeof k === "string" && offered.has(k))) return null;
  return { expiresAt: c.expiresAt, remainingUses: c.remainingUses, personKeys: keys };
}
/** The userId a candidate's server key names (JSON [platform, userId]), or null when the key isn't that shape. */
export function candidateUserId(c) {
  try { const k = JSON.parse(String(c && c.key)); return Array.isArray(k) && k.length === 2 && k[0] === c.platform && typeof k[1] === "string" ? k[1] : null; } catch { return null; }
}
/** The time a request was asked, as Needs you's items show theirs: the clock today, else the date. */
const clockOf = (iso) => { const d = new Date(iso); if (!Number.isFinite(d.getTime())) return ""; return new Date().toDateString() === d.toDateString()
  ? dateTimeText(d, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, []) : dateTimeText(d, { month: "short", day: "numeric" }, []); };
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

/** Every mounted card's "this browser is verified now" ear, for this page load. */
const verifiedListeners = new Set();
function announceVerified(self) { for (const hear of [...verifiedListeners]) if (hear !== self) { try { hear(); } catch { /* one card's read never stops the others' */ } } }

/** One card. `onChange(card)`: the server's fresh card after a decision or a re-read. */
export function RequestContactCard({ card, onChange, focus = false, openHref = null }) {
  const [busy, setBusy] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [granted, setGranted] = useState(false);
  // A read of this card that failed (after verifying, or after a decision whose answer was unknown): its state here may be
  // stale, so it says so, its decision buttons stay off, and Read again only reads (#4497 review R2). Never a POST.
  // Kept in a ref as well: an already-open rule editor holds an older onSave, and its Save must see it too (R3).
  const [readFailed, setReadFailed] = useState(false);
  const unread = useRef(false);
  const readCard = async () => {
    const r = await getCard(tk.id);
    if (r.ok) { unread.current = false; setReadFailed(false); onChange?.(r.data); return true; }
    unread.current = true; setReadFailed(true); setGrantOpen(false);           // the rule editor closes until a read succeeds
    return false;
  };
  const auth = useWebAuthorization();
  const tk = card.ticket, st = stateOf(tk.state);
  const root = card.approvalScope === "root-request";
  const open = st === "pending" && !card.continuedFrom;
  const needsVerify = open && card.actions.requiresVerification;
  const canDecide = open && card.actions.canDecide && !card.actions.requiresVerification;
  const grantable = card.actions.canGrant && Array.isArray(card.grantCandidates) && card.grantCandidates.length > 0;

  // Once this browser is verified, read the same card again (only reading: a decision waits for a click on its buttons).
  // Only the card whose Authorize was pressed watches the confirm come in; it tells every other card on the page, which
  // reads itself again too (the capture look: the others stayed "Authorize this browser to decide.").
  const verified = auth.st && auth.st.state === "verified";
  const waits = useRef(needsVerify);
  waits.current = needsVerify;
  const readAgain = useRef(null);
  readAgain.current = () => { void readCard(); };
  const ear = useRef(null);
  useEffect(() => {
    const hear = () => { if (waits.current) readAgain.current(); };
    ear.current = hear;
    verifiedListeners.add(hear);
    return () => { verifiedListeners.delete(hear); };
  }, []);
  useEffect(() => {
    if (!needsVerify || !verified) return undefined;
    readAgain.current();
    announceVerified(ear.current);
    return undefined;
  }, [needsVerify, verified, tk.id]);

  const reread = async (say) => {
    if (say) toast(say, false);
    await readCard();
  };
  // The one way a decision is sent: never while a send is out, or while this card's state is unknown (a failed read).
  const sending = useRef(false);
  const decide = async (decision, grant) => {
    if (busy || sending.current || unread.current) return false;
    // Held until the whole decision is over — its POST and any read after it — so no other Save can slip in between.
    sending.current = true;
    setBusy(true);
    try {
      const r = await decideCard(card, decision, grant);
      if (r.ok) { if (grant) { setGranted(true); toast(ca("grantSaved"), true); } onChange?.(r.data); return true; }
      if (r.code === "upgrade-required") { toast(r.message || tr("upgrade"), false, { detail: true }); await reread(null); return false; }
      if (r.status === 409 || RC_REREAD.has(r.code)) { await reread(tr("decidedElsewhere")); return false; }
      if (r.code === "verification-required") { resetWebAuthorization(); await reread(null); return false; }
      // A definite refusal (the server said no before deciding) is said; anything else — no answer, an answer that can't be
      // read, a server error — may have committed: read the same card and show what it is now. Never sent again.
      if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404) {
        toast(r.code === "forbidden" ? tr("forbidden") : r.code === "sign-in-required" ? tr("signIn") : r.code === "not-found" ? tr("forbidden")
          : r.code === "invalid-grant" || r.code === "invalid-grant-origin" ? tr("grantInvalid") : tr("failed", r.code), false);
        return false;
      }
      await reread(tr("uncertain"));
      return false;
    } finally { sending.current = false; setBusy(false); }
  };
  // A click decides (Always allow opens its rule first). Before verification the buttons are off: nothing to press.
  const press = (which) => {
    if (!canDecide || readFailed) return;
    if (which === "always") { setGrantOpen(true); return; }
    void decide(which === "decline" ? "decline" : "approve-once");
  };
  const people = candidatePeople(card);
  // Continue (a root: this request and its follow-ups) and Approve once (a legacy one-message forward) are different
  // decisions, so they keep different words. The grant button has the grant editor's own name (#4497 capture check).
  const label = (which) => (which === "continue" ? (root ? tr("continue") : tr("approveOnce")) : which === "always" ? ca("grantSet") : tr("decline"));
  const stateText = st === "approved" && root ? tr("state_approved_root") : ca(`state_${st}`);
  const outcome = st === "approved" || st === "delivered" ? `${tr("forwardedTo", card.targetLabel)} ` : "";
  const saveRule = (c) => {
    const grant = grantFromChoice(card, c);
    if (!grant) { toast(tr("grantInvalid"), false); return false; }
    return decide("approve-once", grant);
  };
  const links = openHref ? html`<a class="btn btn-sm btn-ghost rc-open" href=${openHref}>${ca("needsOpen")}</a>` : null;
  const button = (which, cls) => html`<button type="button" class=${`btn btn-sm${cls}`}
    disabled=${busy || readFailed || !canDecide || (which === "always" && !grantable)} data-choice=${which} onClick=${() => press(which)}>${label(which)}</button>`;

  // The one-card style the user approved for the credits card (the leader, #4492 merge note): a standard Needs-you item —
  // a one-line title, one line of detail (the reason), the rest folded, then normal-size buttons; no raised card.
  const actions = open && (canDecide || needsVerify);
  return html`<article data-trust="permission" class=${`n-item rc-card${focus ? " rc-focus" : ""}`} data-ticket=${tk.id} data-state=${st} data-engine=${card.engine}>
    <span class="n-icon"><${Icon} name="key" size=${18} /></span>
    <div class="n-body">
      <div class="n-title"><strong>${ca("needsTitle", card.sourceLabel, card.targetLabel)}</strong><span class="n-age">${clockOf(tk.createdAt)}</span></div>
      <p class="n-detail rc-reason" data-reason=${card.reason}>${st !== "pending" ? html`<span class=${`tag rc-state${TONE[st] === "ok" ? " s-state ok" : TONE[st] === "bad" ? " s-state bad" : ""}`}>${stateText}</span> ` : null}${outcome ? html`<span class="rc-outcome">${outcome}</span>` : null}${card.continuedFrom ? tr("continuedFrom", shortId(card.continuedFrom)) : reasonText(card)}${open ? html` <span class="rc-scope" data-scope=${card.approvalScope}>${tr(root ? "scopeShortRoot" : "scopeShortOperation")}</span>` : null}</p>
      <details class="n-raw rc-more"><summary>${ca("messageLabel")}</summary>
        ${tk.message ? html`<pre class="n-raw-text rc-message">${tk.message}</pre>` : null}
        <p class="rc-facts"><span class="rc-requester">${requesterText(card.requester)}</span>${INGRESS.has(card.ingress) ? html` · <span class="rc-ingress" data-ingress=${card.ingress}>${tr(`ingress_${card.ingress}`)}</span>` : null}${VERBS.has(tk.verb) ? html` · ${ca(`verb_${tk.verb}`)}` : null}</p>
        ${card.returnAudience && AUDIENCE.has(card.returnAudience.kind) ? html`<p class="rc-return">${tr("repliesTo", tr(`audience_${card.returnAudience.kind}`))}</p>` : null}
        <p class="rc-times" title=${`#${tk.id}`}>${ca("created", when(tk.createdAt))} · ${tk.decidedAt ? tr("decidedAt", when(tk.decidedAt)) : ca("expires", when(tk.expiresAt))}</p>
        ${open ? html`<p class="rc-scope-more">${tr(root ? "scopeRoot" : "scopeOperation")}</p>` : null}
        ${st === "delivered" ? html`<p>${ca("deliveryNote")}</p>` : null}
      </details>
      ${readFailed ? html`<p class="n-detail rc-read-failed" role="status">${tr("readFailed")} <button type="button" class="btn btn-sm rc-read-again" disabled=${busy} onClick=${() => void readCard()}>${tr("readRetry")}</button></p>` : null}
      ${granted ? html`<p class="n-detail"><a class="st-link rc-grant-view" href=${`${detailsPath(tk.target)}?cat=permissions`}>${tr("grantView")}</a></p>` : null}
      ${actions && needsVerify ? html`<div class="rc-verify" role="group" aria-label=${tr("verifyTitle")}><span>${tr("verifyTitle")}</span>${authorizeControl(auth)}</div>` : null}
      ${actions ? html`<div class="n-actions rc-decide">${button("continue", " btn-primary")}${button("always", "")}${button("decline", " btn-ghost")}${links}</div>
        ${!grantable ? html`<p class="n-detail rc-no-grant">${tr("noGrant")}</p>` : null}` : links ? html`<div class="n-actions">${links}</div>` : null}
      ${grantOpen && grantable && canDecide ? html`<${ContactGrantEditor} key=${`${tk.id}:${card.snapshot.ticketRevision}`} people=${people} keyOf=${(p) => p.key}
        source=${card.sourceLabel} target=${card.targetLabel} verb=${tk.verb}
        title=${ca(people.length === 1 ? "grantSetOneTitle" : "allowPeopleTitle")}
        onClose=${() => setGrantOpen(false)} onSave=${saveRule} />` : null}
    </div>
  </article>`;
}
