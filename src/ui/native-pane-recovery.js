/** Retained-pane recovery uses an explicit admin attestation; it never resubmits a chat message. */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { guestPage } from "/assets/app-store.js";
import { Dialog } from "/assets/ui-dialog.js";
import { toast } from "/assets/ui-toast.js";
import "./chat-strings.js";
export function NativePaneRecovery({ name, inst, lease }) {
  const [dialog, setDialog] = useState(false), [checked, setChecked] = useState(false), [busy, setBusy] = useState(false);
  const confirmation = useRef(null), inFlight = useRef(false), recovery = inst.native_recovery;
  useEffect(() => { setDialog(false); setChecked(false); }, [recovery?.launchId, recovery?.kind]);
  const act = async (path, body) => {
    if (inFlight.current || !lease.current()) return;
    inFlight.current = true; setBusy(true);
    try {
      const response = await lease.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      if (!lease.current()) return;
      if (!response.ok || result.error) toast(result.error || t("chat.disconnected"), false);
      else { setDialog(false); setChecked(false); }
    } catch (error) { if (lease.current()) toast(error.message || t("chat.disconnected"), false); }
    finally { inFlight.current = false; if (lease.current()) setBusy(false); }
  };
  if (guestPage() || inst.native_adapter !== "pane") return null;
  if (!recovery) return ["stopped", "crashed"].includes(inst.status)
    ? html`<div class="windows-agent-blocked"><button type="button" class="btn" disabled=${busy} onClick=${() => act(`/ui/start/${encodeURIComponent(name)}`)}>${t("chat.start")}</button></div>` : null;
  return html`<div class="windows-agent-blocked" role="alert"><p>${t(recovery.kind === "host-upgrade" ? "chat.paneHostUpgrade" : "chat.paneRecoveryNeeded")}</p>
    ${recovery.kind === "host-upgrade" ? html`<button type="button" class="btn" disabled=${busy} onClick=${() => act(`/ui/stop/${encodeURIComponent(name)}`)}>${t("chat.stopInstance")}</button>` : recovery.launchId ? html`<button type="button" class="btn" disabled=${busy} onClick=${() => { confirmation.current = {name,launchId:recovery.launchId}; setChecked(false); setDialog(true); }}>${t("chat.paneRecover")}</button>` : null}
    <button type="button" class="btn" disabled=${busy} onClick=${() => act(`/ui/start/${encodeURIComponent(name)}`)}>${t("chat.start")}</button>
    ${dialog ? html`<${Dialog} title=${t("chat.paneRecover")} onClose=${() => { if (!busy) setDialog(false); }}>
      <p>${t("chat.paneRecoverConfirm", inst.display_name || name)}</p>
      <label><input type="checkbox" checked=${checked} disabled=${busy} onChange=${event => setChecked(event.target.checked)} />${t("chat.paneProcessesStopped")}</label>
      <button type="button" class="btn" disabled=${!checked || busy || confirmation.current?.name !== name || confirmation.current?.launchId !== recovery.launchId} onClick=${() => { if (checked && confirmation.current?.name === name && confirmation.current?.launchId === recovery.launchId) act(`/ui/instances/${encodeURIComponent(name)}/recover-pane`, { confirmedStopped: true, launchId: confirmation.current.launchId }); }}>${t("chat.paneRecoverConfirmed")}</button>
    </${Dialog}>` : null}
  </div>`;
}
