// M-3339 (A2): an agent page's Permissions (agent-details-settings.js, category "permissions") — on the contact
// authorization contract (src/contact-auth-types.ts; docs/design/classic-contact-authorizations.md).
// - A ClassicBot room's page: its mode (restricted, or the older setting), the command-line guard's coverage, and the
//   room's tools (public reading, exact MCP tools; what would stop if a legacy room switched).
// - A worker's page: who approves requests to it (or the channel admins it inherits), and its allowed contacts.
// - Both: the history.
// Its own read and its own saves (PUT with the revision read; a 409 reads again and says so) — never staged with the
// page's settings Save. The server decides who may see or change anything (canManage / canSetMode); nothing here grants.
// It reads again on the stream's contact-auth frame for this agent (a newer revision) and when the page is shown again.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { appStore, useStore } from "/assets/app-store.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { Skeleton, ErrorState } from "/assets/ui-states.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { ca, contactPersonLabel, contactWhen } from "./contact-auth-strings.js";
import { getPermissions, putPermissions, clearOrigin, shortTicketId } from "./contact-auth-client.js";
import { labelOf } from "/assets/instance-nav.js";
import { ContactGrantEditor } from "./contact-grant-editor.js";
import { REASONS } from "./contact-authorizations.js";
import { groupWouldDisable } from "./contact-tool-groups.js";
import { dateTimeText } from "/assets/clock-text.js";

const when = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? dateTimeText(d, { dateStyle: "medium", timeStyle: "short" }, []) : ""; };
/** A3's guard reason codes (ContactGuardStatus.reason), each said in words (contact-auth-strings.js guardReason_<code>). */
const GUARD_REASONS = new Set(["legacy-mode", "unsupported-backend", "unsupported-platform", "unsupported-version", "cli-mode", "load-not-verified", "stale-policy",
  "stale-launch", "not-running", "invalid-policy", "missing-bound-mcp", "missing-selected-mcp", "guard-files-changed", "invalid-load-receipt", "guard-unavailable", "binary-changed"]);
/**
 * The leader's A3 decision (via Cairn): a restricted room whose AI tool, version, platform or mode the guard doesn't cover
 * keeps running with that tool's normal permissions — only contact approval applies. Said plainly (never "ready", never only in
 * a tooltip), and before the mode is set (the mode card, the switch's confirm, Needs you's suggestion). A missing selected MCP
 * tool is partial coverage (the base guard runs): its own reason says which, not this.
 */
export const notCovered = (g) => !!g && g.state === "not-covered" && g.reason !== "missing-selected-mcp";
const GUARD_TONE = { ready: "ok", "restart-required": "warn", "not-covered": "warn", failed: "bad" };
/** The guard's state as said — anything the contract doesn't name is never shown as ready. */
const guardState = (g) => (g && ["ready", "restart-required", "not-covered", "failed"].includes(g.state) ? g.state : "failed");
const personLabel = (p) => (p && (p.label || p.userId)) || "";

/** Keep `name`'s permissions read: once, on its contact-auth frame (a newer revision), and when the page is shown again. */
export function usePermissions(name) {
  const [state, setState] = useState({ loading: true });
  const rev = useRef(-1);
  const originRev = useRef(-1);
  const read = async () => {
    const r = await getPermissions(name);
    if (r.ok) { rev.current = r.data.revision; originRev.current = r.data.originState?.revision ?? -1; setState({ data: r.data }); } else setState((s) => ({ ...(s.data ? { data: s.data } : {}), error: r.code }));
    return r;
  };
  useEffect(() => {
    let live = true;
    void read().then(() => { if (!live) rev.current = -1; });
    const sub = appStore.get().streamOn;
    const off = typeof sub === "function" ? sub("contact-auth", (d) => { if (d && d.instance === name && (!(Number(d.revision) <= rev.current) || Number(d.originRevision) > originRev.current)) void read(); }) : null;
    const offMessage = typeof sub === "function" ? sub("message", (d) => { if (d?.instance === name) void read(); }) : null;
    const onShow = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", onShow);
    return () => { live = false; if (typeof off === "function") off(); if (typeof offMessage === "function") offMessage(); document.removeEventListener("visibilitychange", onShow); };
  }, [name]);
  return { ...state, read, setData: (data) => { rev.current = data.revision; originRev.current = data.originState?.revision ?? -1; setState({ data }); } };
}

/**
 * What would stop if this legacy room switched — AgEnD's known removals; when the backend's own inventory couldn't be read
 * (impactComplete false) that is said too, so the list is never taken as everything.
 * M-3387: by kind with counts (contact-tool-groups.js), the AI tool's own tools on their own line, the two layers said, and
 * every name behind "show all".
 */
function WouldDisable({ tools, complete }) {
  const incomplete = complete === false ? html`<p class="feedback warning contact-impact-incomplete">${ca("impactIncomplete")}</p>` : null;
  if (!tools || !tools.length) return complete === false ? incomplete : html`<p class="note">${ca("wouldDisableNone")}</p>`;
  const { groups, cli, agendCount } = groupWouldDisable(tools);
  return html`<div class="contact-would">
    ${agendCount ? html`<p>${ca("toolsLostTitle", agendCount)}</p><ul class="contact-would-groups">${groups.map((g) => html`<li key=${g.id} data-group=${g.id}>${ca("toolGroupLine", ca(`toolGroup_${g.id}`), g.tools.length)}</li>`)}</ul>` : null}
    ${cli.length ? html`<p class="contact-would-cli">${ca("cliToolsLine", cli.length, cli.join(", "))}</p>` : null}
    <p class="note contact-would-layers">${ca("toolLayers")}</p>
    <details class="contact-would-all"><summary>${ca("showAllTools", tools.length)}</summary><ul>${tools.map((n) => html`<li key=${n} class="mono">${n}</li>`)}</ul></details>
    ${incomplete}</div>`;
}
/** The same, as the confirm's text (paragraphs): the kinds with counts, the AI tool's own tools, the two layers. */
export function wouldDisableText(roomTools, guard) {
  const would = roomTools?.wouldDisable || [];
  const { groups, cli, agendCount } = groupWouldDisable(would);
  const parts = [would.length ? "" : roomTools?.impactComplete === false ? "" : ca("wouldDisableNone")];
  if (agendCount) parts.push([ca("toolsLostTitle", agendCount), ...groups.map((g) => ca("toolGroupLine", ca(`toolGroup_${g.id}`), g.tools.length))].join("\n"));
  if (cli.length) parts.push(ca("cliToolsLine", cli.length, cli.join(", ")));
  if (would.length) parts.push(ca("toolLayers"));
  if (roomTools?.impactComplete === false) parts.push(ca("impactIncomplete"));
  if (notCovered(guard)) parts.push(ca("notCoveredWarning"));
  return parts.filter(Boolean).join("\n\n");
}
/** M-3387: the confirm's "show all": every name that would stop, or null when none. */
export function wouldDisableMore(roomTools) {
  const would = roomTools?.wouldDisable || [];
  return would.length ? { label: ca("showAllTools", would.length), lines: would } : null;
}

export function ContactPermissionsPanel({ name }) {
  const perm = usePermissions(name);
  const { instances } = useStore(appStore);
  const agentLabel = value => labelOf((instances || []).find(row => row.name === value) || { name: value });
  const [busy, setBusy] = useState(false);
  const [mcpDraft, setMcpDraft] = useState("");
  const [pick, setPick] = useState("");
  const [editing, setEditing] = useState(null), [grantFilter, setGrantFilter] = useState("");
  const p = perm.data;
  useEffect(() => { setEditing(null); }, [name, p?.revision]);
  if (!p && perm.loading !== false && !perm.error) return html`<${Skeleton} lines=${5} label=${ca("loading")} />`;
  if (!p) return perm.error === "verification-required" ? html`<p class="note contact-verify">${ca("verifyFirst")}</p>`
    : perm.error === "forbidden" ? html`<p class="note contact-forbidden">${ca("forbidden")}</p>`
    : html`<${ErrorState} message=${ca(perm.error === "unavailable" ? "unavailable" : "loadFailed")} onRetry=${() => void perm.read()} />`;
  // Who may change what (the server says; Sentinel's seam): the source room's admins its mode and tools (canSetMode); the
  // target's approvers its approvers and allowed contacts (canManage).
  const canMode = p.classicRoom && p.canSetMode === true;
  const canManage = p.canManage === true;
  /** One write with the revision read; a refusal says why (a stale one reads again first). */
  const write = async (patch) => {
    if (busy) return false;
    setBusy(true);
    const r = await putPermissions(name, { revision: p.revision, ...patch });
    setBusy(false);
    if (r.ok) { perm.setData(r.data); toast(ca("saved"), true); return true; }
    if (r.code === "conflict") { await perm.read(); toast(ca("stale"), false); return false; }
    toast(ca(r.code === "verification-required" ? "verifyFirst" : r.code === "forbidden" ? "forbidden" : r.code === "unavailable" ? "unavailable" : r.code === "invalid-approver" ? "invalidApprover" : "saveFailed"), false);
    return false;
  };
  const switchMode = async (mode) => {
    const toRestricted = mode === "restricted";
    const ok = await confirmDialog({ title: ca(toRestricted ? "confirmRestricted" : "confirmLegacy"), message: toRestricted
      ? [ca("modeRestrictedNote"), ca("switchOriginNote"), wouldDisableText(p.roomTools, p.nativeGuard)].join("\n\n")
      : ca("modeLegacyNote"), ...(toRestricted ? { more: wouldDisableMore(p.roomTools) } : {}),
      confirmLabel: ca(toRestricted ? "switchRestricted" : "switchLegacy"), danger: !toRestricted });
    if (ok) await write({ mode });
  };
  const clearRetainedOrigin = async () => {
    if (busy || !p.originState?.canClear) return;
    setBusy(true);
    const confirmed = await confirmDialog({ title: ca("originClear"), message: ca("originClearConfirm"),
      confirmLabel: ca("originClear"), danger: true });
    if (!confirmed) { setBusy(false); return; }
    const r = await clearOrigin(name, { revision: p.revision, originRevision: p.originState.revision, generation: p.originState.generation });
    setBusy(false);
    if (r.ok) { perm.setData(r.data); toast(ca("originCleared"), true); return; }
    if (r.code === "conflict") { await perm.read(); toast(ca("stale"), false); return; }
    toast(ca(r.code === "verification-required" ? "verifyFirst" : r.code === "forbidden" ? "forbidden" : r.code === "unavailable" ? "unavailable" : "saveFailed"), false);
  };
  const tools = p.roomTools || { publicRead: false, allowedMcpTools: [], wouldDisable: [] };
  const setTools = (next) => write({ roomTools: { publicRead: next.publicRead, allowedMcpTools: next.allowedMcpTools } });
  const addMcp = async (e) => {
    e.preventDefault();
    const n = mcpDraft.trim();
    if (!n || tools.allowedMcpTools.some((x) => x.name === n)) return;
    if (await setTools({ ...tools, allowedMcpTools: [...tools.allowedMcpTools, { name: n, kind: "mcp", usesOwnerAccount: false }] })) setMcpDraft("");
  };
  const grantsWrite = (rows) => write({ grants: rows.map(({ id, person, source, target, verbs, expiresAt, remainingUses }) => ({ id, person, source, target, verbs, expiresAt, remainingUses })) });
  const g = guardState(p.nativeGuard);
  const shownGrants = p.grants.filter(gr => (gr.person.label || gr.person.userId).toLocaleLowerCase().includes(grantFilter.toLocaleLowerCase()));
  return html`<div class="contact-perm" aria-busy=${busy ? "true" : undefined}>
    ${p.originRestriction?.active && REASONS.has(p.originRestriction.reason) ? html`<p class="feedback warning contact-origin-restriction" role="status" data-reason=${p.originRestriction.reason}>
      ${ca(`reason_${p.originRestriction.reason}`)} ${ca("resetNote")}</p>` : null}
    ${!canManage && !canMode ? html`<p class="s-info contact-readonly"><span aria-hidden="true">ⓘ</span><span>${ca("readOnly")}</span></p>` : null}
    ${p.classicRoom ? html`<section class="card contact-mode" data-mode=${p.mode}>
      <h3>${ca("modeTitle")}</h3>
      ${p.suggestRestricted && p.mode !== "restricted" ? html`<p class="feedback warning contact-suggest-banner" role="status">${ca("suggestBanner")}</p>` : null}
      <p class="contact-mode-line"><span class=${`contact-pill ${p.mode === "restricted" ? "ok" : "warn"}`}>${ca(p.mode === "restricted" ? "modeRestricted" : "modeLegacy")}</span></p>
      ${p.mode !== "restricted" ? html`<p class="feedback warning contact-origin-switch">${ca("switchOriginNote")}</p>` : null}
      <p class="note">${ca(p.mode === "restricted" ? "modeRestrictedNote" : "modeLegacyNote")}</p>
      ${p.mode !== "restricted" ? html`<${WouldDisable} tools=${tools.wouldDisable} complete=${tools.impactComplete} />` : null}
      ${notCovered(p.nativeGuard) ? html`<p class="feedback warning contact-not-covered" role="status">${ca("notCoveredWarning")}</p>` : null}
      ${canMode ? html`<div class="field-row"><button type="button" class=${`btn btn-sm${p.mode === "restricted" ? "" : " btn-primary"}`} disabled=${busy}
          onClick=${() => switchMode(p.mode === "restricted" ? "legacy" : "restricted")}>${ca(p.mode === "restricted" ? "switchLegacy" : "switchRestricted")}</button></div>` : null}
    </section>
    <section class="card contact-guard" data-guard=${g}>
      <h3>${ca("guardTitle")}</h3>
      <p><span class=${`contact-pill ${GUARD_TONE[g]}`}>${ca(`guard_${g}`)}</span>${p.nativeGuard?.backend ? html` <span class="muted">${ca("guardBackend", p.nativeGuard.version ? `${p.nativeGuard.backend} ${p.nativeGuard.version}` : p.nativeGuard.backend)}</span>` : null}</p>
      ${/* A3's reason is a code (Cairn): said in words; one this page doesn't know, generically — never the code itself. */ ""}
      ${notCovered(p.nativeGuard) ? html`<p class="feedback warning contact-not-covered">${ca("notCoveredWarning")}</p>` : null}
      ${p.nativeGuard?.reason ? html`<p class="note contact-guard-reason">${GUARD_REASONS.has(p.nativeGuard.reason) ? ca(`guardReason_${p.nativeGuard.reason}`) : ca("guardReasonOther")}</p>` : null}
      <p class="note">${ca("guardNote")}</p>
    </section>
    <section class="card contact-tools">
      <h3>${ca("toolsTitle")}</h3>
      <label class="check contact-toggle"><input type="checkbox" checked=${!!tools.publicRead} disabled=${!canMode || busy}
          onChange=${(e) => void setTools({ ...tools, publicRead: e.currentTarget.checked })} /><span>${ca("publicRead")}</span></label>
      <p class="note">${ca("publicReadNote")}</p>
      <h4>${ca("mcpTitle")}</h4>
      ${tools.allowedMcpTools.length ? html`<ul class="contact-list">${tools.allowedMcpTools.map((x) => html`<li key=${x.name}>
          <span class="mono">${x.name}</span>${x.kind === "public-read" ? html` <span class="muted">${ca("mcpPublicRead")}</span>` : null}
          ${x.usesOwnerAccount ? html`<p class="feedback warning contact-owner-warning"><${Icon} name="alert" size=${14} /><span>${x.accountWarning || ca("mcpOwnerWarning")}</span></p>` : null}
          ${canMode ? html`<button type="button" class="icon-btn" aria-label=${ca("mcpRemove", x.name)} title=${ca("mcpRemove", x.name)} disabled=${busy}
              onClick=${() => void setTools({ ...tools, allowedMcpTools: tools.allowedMcpTools.filter((y) => y.name !== x.name) })}><${Icon} name="trash" size=${16} /></button>` : null}</li>`)}</ul>`
        : html`<p class="note">${ca("mcpNone")}</p>`}
      ${canMode ? html`<form class="field-row contact-mcp-add" onSubmit=${addMcp}><label class="sr-only" for=${`contact-mcp-${name}`}>${ca("mcpAddLabel")}</label>
          <input id=${`contact-mcp-${name}`} class="input mono" placeholder=${ca("mcpAddLabel")} value=${mcpDraft} onInput=${(e) => setMcpDraft(e.currentTarget.value)} />
          <button type="submit" class="btn btn-sm" disabled=${busy || !mcpDraft.trim()}>${ca("mcpAdd")}</button></form>` : null}
      <p class="note">${ca("offByDefault")}</p>
    </section>` : html`<section class="card contact-approvers">
      <h3>${ca("approversTitle")}</h3>
      ${p.approvers.length ? html`<ul class="contact-list">${p.approvers.map((a) => html`<li key=${`${a.platform}:${a.adapterId}:${a.userId}`}><span>${personLabel(a)}</span> <span class="muted">${a.platform}</span>
          ${canManage && !p.inheritedApprovers ? html`<button type="button" class="icon-btn" aria-label=${ca("approverRemove", personLabel(a))} title=${ca("approverRemove", personLabel(a))} disabled=${busy}
              onClick=${() => void write({ approvers: p.approvers.filter((x) => x !== a) })}><${Icon} name="trash" size=${16} /></button>` : null}</li>`)}</ul>`
        : html`<p class="feedback warning">${ca("approversNone")}</p>`}
      ${p.inheritedApprovers ? html`<p class="note">${ca("approversInherited")}</p>` : canManage ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => void write({ approvers: [] })}>${ca("approversReset")}</button>` : null}
      ${canManage ? (() => {
        // Slice 1: an approver is one of the server's eligible people (a Fleet admin or the verified host operator) — a
        // pick, never a typed name; the server refuses anyone else (invalid-approver).
        const key = (x) => `${x.platform}:${x.adapterId}:${x.userId}`, have = new Set(p.approvers.map(key));
        const left = (p.eligibleApprovers || []).filter((x) => !have.has(key(x)));
        return left.length ? html`<form class="field-row contact-approver-add" onSubmit=${(e) => { e.preventDefault(); const who = left.find((x) => key(x) === pick); if (who) void write({ approvers: [...p.approvers, who] }).then((ok) => { if (ok) setPick(""); }); }}>
          <label class="sr-only" for=${`contact-approver-${name}`}>${ca("approverPick")}</label>
          <select id=${`contact-approver-${name}`} class="input" value=${pick} disabled=${busy} onChange=${(e) => setPick(e.currentTarget.value)}>
            <option value="">${ca("approverNone")}</option>${left.map((x) => html`<option key=${key(x)} value=${key(x)}>${personLabel(x)} · ${x.platform}</option>`)}</select>
          <button type="submit" class="btn btn-sm" disabled=${busy || !pick}>${ca("approverAdd")}</button></form>` : null;
      })() : null}
      <p class="note">${ca("approverAdmins")}</p>
    </section>
`}
    <section class="card contact-grants">
      <h3>${ca("grantsTitle")}</h3>
      <p class="note">${ca("grantsNote")}</p>
      <label class="field"><span>${ca("grantFilter")}</span><input class="input" type="search" value=${grantFilter} onInput=${e => setGrantFilter(e.currentTarget.value)} /></label>
      ${p.grants.length && !shownGrants.length ? html`<p class="note">${ca("grantNoMatches")}</p>` : null}
      ${p.grants.length ? html`<ul class="contact-list">${shownGrants.map((gr) => html`<li key=${gr.id}>
          <div><strong>${personLabel(gr.person)}</strong> <span class="muted">${ca("grantRow", agentLabel(gr.source), agentLabel(gr.target))}</span></div>
          <div class="muted contact-grant-meta"><span>${ca("grantVerbs", gr.verbs.map((v) => ca(`verb_${v}`)).join(", "))}</span><span>${ca("grantExpires", contactWhen(gr.expiresAt))}</span><span>${gr.remainingUses == null ? ca("grantUnlimited") : ca("grantUses", gr.remainingUses)}</span></div>
          <p class="note">${ca("grantCreated", contactPersonLabel(gr.createdBy), contactWhen(gr.createdAt))}</p>
          ${canManage ? html`<div class="s-actions"><button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => setEditing({ grant: gr, revision: p.revision })}>${ca("grantAdjust")}</button><button type="button" class="btn btn-sm btn-ghost" disabled=${busy} onClick=${async () => {
            if (await confirmDialog({ message: ca("grantRemoveConfirm"), confirmLabel: ca("grantRemove"), danger: true })) void grantsWrite(p.grants.filter((x) => x.id !== gr.id));
          }}>${ca("grantRemove")}</button></div>` : null}</li>`)}</ul>` : html`<p class="note">${ca("grantsNone")}</p>`}
    </section>
    ${editing && editing.revision === p.revision && canManage ? html`<${ContactGrantEditor} key=${`${name}:${p.revision}:${editing.grant.id}`} grant=${editing.grant} people=${[editing.grant.person]} source=${agentLabel(editing.grant.source)} target=${agentLabel(editing.grant.target)}
      onClose=${() => setEditing(null)} onSave=${choice => grantsWrite(p.grants.map(row => row.id === editing.grant.id ? { ...row, expiresAt: choice.expiresAt, remainingUses: choice.remainingUses, verbs: choice.verbs } : row))} />` : null}
    ${p.originState ? html`<section class="card contact-origin">
      <h3>${ca("originTitle")}</h3>
      <p class="contact-origin-state"><strong>${ca(`originKind_${p.originState.kind}`)}</strong></p>
      <p class="note">${ca("originRetainedNote")}</p>
      <p>${ca("originPeople")}</p>
      ${p.originState.people.length ? html`<ul class="contact-list contact-origin-people">${p.originState.people.map((person) => html`<li key=${`${person.platform}:${person.adapterId}:${person.userId}`}>
        <strong>${personLabel(person)}</strong> <span class="muted">${person.platform} · ${person.adapterId} · ${person.userId}</span></li>`)}</ul>` : html`<p class="note">${ca("originPeopleNone")}</p>`}
      <p class="contact-origin-chain">${ca("originChain")}: ${p.originState.chain.length ? p.originState.chain.join(" → ") : ca("originChainNone")}</p>
      <p class="note">${ca("originReceipts", p.originState.receiptCount)}</p>
      ${p.originState.lastCleared ? html`<p class="contact-origin-last">${ca("originLastCleared", personLabel(p.originState.lastCleared.actor), when(p.originState.lastCleared.at))}</p>` : null}
      ${p.originState.canClear ? html`<button type="button" class="btn btn-sm btn-danger contact-origin-clear" disabled=${busy} onClick=${() => void clearRetainedOrigin()}>${ca("originClear")}</button>` : null}
    </section>` : null}
    <section class="card contact-history">
      <h3>${ca("historyTitle")}</h3>
      ${p.history.length ? html`<ul class="contact-list contact-history-list">${p.history.map((h) => html`<li key=${h.id}>
          <span class="mono muted">${when(h.at)}</span> <strong>${ca(`action_${h.action}`)}</strong> <span>${personLabel(h.actor)}</span>
          ${h.ticketId ? html` <a href=${`/ui/fleet/authorizations?ticket=${encodeURIComponent(h.ticketId)}`} title=${h.ticketId}>#${shortTicketId(h.ticketId)}</a>` : null}
          ${h.summary ? html`<div class="muted">${h.summary}</div>` : null}</li>`)}</ul>` : html`<p class="note">${ca("historyNone")}</p>`}
    </section>
  </div>`;
}
