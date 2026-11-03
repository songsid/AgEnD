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

/** Read the list again (one read at a time; a change meanwhile reads once more). */
export function refreshProposals() {
  if (reading) { again = true; return reading; }
  reading = fetch("/ui/agent-proposals", { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const list = d && Array.isArray(d.proposals) ? d.proposals : [];
      appStore.set({ proposals: list, proposalsOwner: !!(d && d.owner) });
    })
    .catch(() => null)
    .finally(() => { reading = null; if (again) { again = false; void refreshProposals(); } });
  return reading;
}

/** Once per page: follow the stream's change event, read once. Never on the public link (its pages get nothing here). */
export function installProposals() {
  if (installed) return;
  if (typeof document !== "undefined" && document.body && document.body.dataset.publicLink === "1") return;
  installed = true;
  const on = appStore.get().streamOn;
  if (typeof on === "function") on("agent_proposals", () => { void refreshProposals(); });
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
  return { ok: !!res.ok, view: (body && body.view) || null, agent: (body && body.agent) || null, message: (body && body.message) || null };
}

/** For tests: as on a fresh page. */
export function resetProposals() { installed = false; reading = null; again = false; }
