// M-3145 (docs/design/hub-fleet-versions.md §4.1, phase 3): Fleet Settings → Hub, in the Hub connection card under
// "Shared agents" — the owner's switch that lets this Hub's administrator start an AgEnD update on this computer.
// Off by default; turning it on asks once; off at any time (that cancels a waiting request — the Fleet's own rule).
// A Fleet started by hand (not a service) cannot undo a failed update by itself: the switch is shown, disabled, and says
// why. Only on the Fleet's own dashboard (not over the public link), like the rest of Hub settings.
// The Fleet's settings client carries it (hubUpdateConsent / setHubUpdateConsent); a client without them (an older
// Fleet) draws nothing. A module of its own with its own words (upgrade skew: an older dictionary still has them all).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { confirmDialog } from "/assets/ui-confirm.js";

register("hubUpdates", {
  en: {
    switch: "Let this Hub's administrator update this Fleet",
    lead: "When this is on, an administrator of {0} can start an AgEnD update on this computer. It installs only versions published by AgEnD, waits until your agents are idle, tells you before and after, and goes back to the previous version if the update fails. You can turn this off at any time.",
    askTitle: "Let {0}'s administrator update this Fleet?", allow: "Allow",
    notService: "Not available: this AgEnD was started by hand, so a failed update could not be undone automatically.",
    failed: "It wasn't changed. Try again.",
  },
  "zh-TW": {
    switch: "允許這個 Hub 的管理員更新這個 Fleet",
    lead: "開啟後，{0} 的管理員可以在這台電腦上啟動 AgEnD 更新。只會安裝 AgEnD 正式發布的版本，會等你的 Agent 都閒置才開始，更新前後都會通知你，失敗時會回到原本的版本。你隨時可以關閉。",
    askTitle: "要允許 {0} 的管理員更新這個 Fleet 嗎？", allow: "允許",
    notService: "無法使用：這個 AgEnD 是手動啟動的，更新失敗時無法自動復原。",
    failed: "沒有變更，請再試一次。",
  },
});
export const hu = (key, ...args) => t(`hubUpdates.${key}`, ...args);

/**
 * The switch. `client.hubUpdateConsent()` → { ok, on, available, reason? } (`available: false, reason: "not-service"`:
 * started by hand); `client.setHubUpdateConsent(on)` → the same shape. `hubName`: the paired Hub's name.
 */
export function HubUpdateConsent({ client, hubName = "" }) {
  const [state, setState] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    if (typeof client?.hubUpdateConsent === "function") client.hubUpdateConsent().then((r) => { if (live.current && r && r.ok !== false) setState(r); }, () => {});
    return () => { live.current = false; };
  }, [client]);
  if (!state || typeof client?.setHubUpdateConsent !== "function") return null;
  const available = state.available !== false;
  const change = async (on, box) => {
    if (busy) return;
    setErr("");
    // On asks once (the owner's consent); off needs no question. Cancel puts the switch back (the page's own state never
    // moved, so nothing would redraw it).
    if (on && !(await confirmDialog({ title: hu("askTitle", hubName), message: hu("lead", hubName), confirmLabel: hu("allow") }))) { if (box) box.checked = false; return; }
    setBusy(true);
    const r = await client.setHubUpdateConsent(on).catch(() => null);
    if (!live.current) return;
    setBusy(false);
    if (r && r.ok !== false) setState(r);
    else { setErr(hu("failed")); if (box) box.checked = state.on === true; }   // not changed: the switch shows what is saved
  };
  return html`<div class="hub-update-consent">
    <label class="check hub-update-switch"><input class="s-ui-toggle" type="checkbox" role="switch" id="hubUpdateConsent"
      checked=${available && state.on === true} disabled=${!available || busy} aria-describedby="hubUpdateConsent-note"
      onChange=${(e) => { void change(e.target.checked, e.target); }} /><span>${hu("switch")}</span></label>
    <p class="note" id="hubUpdateConsent-note">${available ? hu("lead", hubName) : hu("notService")}</p>
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
  </div>`;
}
