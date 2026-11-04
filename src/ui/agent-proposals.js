// alpha.2 (M-2300; #2973's agent requests, junsion's §6): an agent asked for a Windows agent (create_instance with
// runtime "windows", or update_instance_config on one). On a fleet with no chat connection there is no General card to
// confirm it in, so its owner — the `agend web --code` session on the AgEnD computer, web-verified (decision 28c2d3a3) —
// decides it here, in Needs you.
// - The list is read from GET /ui/agent-proposals, which answers the owner only (anyone else reads an empty list): on
//   install, and each time the stream's `agent_proposals` event (it carries nothing) says it changed.
// - It lives in the app store (`proposals`), so the Needs you count includes it on every page.
// - A decision is POST /ui/agent-proposals/<id> {decision}; the server asks the owner, the request and the target machine
//   again, and answers with the request as it now stands (applied, rejected, expired, already decided, failed…).
// Installed once per admin page (app.js), and by the Needs you panel itself (a tab opened before an upgrade has the new
// panel but not the new app.js: it installs it when it is first shown).
import { appStore } from "/assets/app-store.js";

let installed = false, reading = null, again = false;
// #2997 review r2 (Prism P2): the newest revision a status frame showed, and the one the list was last READ at — a read
// that failed (the network, a 5xx, an answer that is not a list) leaves `loaded` behind, so the next status frame (the
// same revision included) or the bounded retry reads again; never a revision taken as read before a read succeeded.
let observed = null, loaded = null, retries = 0, retryTimer = null;
const RETRY_MS = 5000, RETRY_MAX = 5;

/** Read the list again (one read at a time; a change meanwhile reads once more). Resolves true when it was read. */
export function refreshProposals() {
  if (reading) { again = true; return reading; }
  const want = observed;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  reading = fetch("/ui/agent-proposals", { headers: { Accept: "application/json" } })
    .then((r) => { if (!r.ok) throw new Error(`agent proposals: ${r.status}`); return r.json(); })
    .then((d) => {
      if (!d || !Array.isArray(d.proposals)) throw new Error("agent proposals: not a list");
      appStore.set({ proposals: d.proposals, proposalsOwner: !!d.owner });
      loaded = want; retries = 0;
      return true;
    })
    .catch(() => {
      // Not read: try again a few times on its own (a page whose stream sends no more status frames), and at any status
      // frame meanwhile (its revision is still ahead of `loaded`).
      if (retries < RETRY_MAX && !retryTimer) { retries++; retryTimer = setTimeout(() => { retryTimer = null; void refreshProposals(); }, RETRY_MS); }
      return false;
    })
    .finally(() => {
      reading = null;
      // A change while it was out (a ping, a newer revision): read once more.
      if (again) { again = false; void refreshProposals(); }
    });
  return reading;
}

/**
 * Once per page: read once, then again on the stream's `agent_proposals` ping (live) and whenever a status frame shows a
 * revision the list was not read at yet (#2997 review: a page that polls /ui/poll, one that reconnected, and a tab from
 * before the upgrade — whose stream knows no `agent_proposals` event — all still apply status frames; r2: until a read
 * at that revision succeeds). Never on the public link.
 */
export function installProposals() {
  if (installed) return;
  if (typeof document !== "undefined" && document.body && document.body.dataset.publicLink === "1") return;
  installed = true;
  const on = appStore.get().streamOn;
  if (typeof on === "function") {
    on("agent_proposals", () => { void refreshProposals(); });
    on("status", (d) => {
      const next = d && Number.isSafeInteger(d.agent_proposals_rev) ? d.agent_proposals_rev : null;
      if (next === null) return;
      observed = next;
      if (observed !== loaded) void refreshProposals();              // a newer revision, or one not yet read successfully
    });
  }
  void refreshProposals();
}

/**
 * The owner's Approve ("confirm") or Reject. Resolves to { ok, view, agent, message }: the request as the server says
 * it now stands (its outcome), the new agent's name when it was created, or why nothing happened.
 */
export async function decideProposal(id, decision) {
  let res, body = null;
  try {
    res = await fetch(`/ui/agent-proposals/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
    try { body = await res.json(); } catch { body = null; }
  } catch { return { ok: false, view: null, agent: null, message: null }; }
  void refreshProposals();
  return { ok: !!res.ok, view: (body && body.view) || null, agent: (body && body.agent) || null, message: (body && body.message) || null,
    error: (body && typeof body.error === "string" && body.error) || (res.ok ? null : `http_${res.status}`) };
}

/** For tests: as on a fresh page. */
export function resetProposals() {
  installed = false; reading = null; again = false; observed = null; loaded = null; retries = 0;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}
