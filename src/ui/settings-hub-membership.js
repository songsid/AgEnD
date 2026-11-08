// Pure lazy owner Settings while off. Hub clients/pairing UI load only after a saved on state and a member page mark.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Skeleton, ErrorState } from "/assets/ui-states.js";
import { register, t } from "/assets/app-i18n.js";
import { api, confirmedWrite } from "./settings-confirm.js";
register("hubMembership", {
  en: {
    title: "Hub membership", enabled: "Allow this fleet to connect to a Hub",
    hint: "Off by default. Enabling does not pair a Hub or share an agent; choose those separately below.",
    off: "Turning this off stops new Hub work and answer disclosure. Existing agent conversations remain.",
    loading: "Reading membership settings…", pending: "Waiting for owner confirmation…",
    failed: "The membership change could not be verified. Check again before trying another change.",
    unavailable: "Membership settings are unavailable. Open this fleet's own owner Settings and check again.",
    retry: "Check again",
  },
  "zh-TW": {
    title: "Hub 成員功能", enabled: "允許這個 Fleet 連線至 Hub",
    hint: "預設關閉。啟用不會自動配對 Hub 或分享 Agent；請在下方另外選擇。",
    off: "關閉後會停止新的 Hub 工作與回答傳送，既有 Agent 對話會保留。",
    loading: "正在讀取成員設定…", pending: "等待擁有者確認…",
    failed: "無法確認成員設定是否已變更。請再次檢查，再嘗試其他變更。",
    unavailable: "目前無法使用成員設定。請開啟這個 Fleet 自己的擁有者設定頁面，再次檢查。",
    retry: "再次檢查",
  },
});
const copy = key => t(`hubMembership.${key}`);
const path = "/api/settings/hub/membership";
const markedMember = () => String(globalThis.document?.body?.dataset?.hub || "").split(/\s+/).includes("member");
/**
 * The leader's cid-hub-no-reload (#3319: the user stuck on "Reload page"): the page's Hub mark follows the saved switch, in
 * place — what the server would mark a fresh page with (web-api hubBodyAttrs: `hub_member.enabled`, never over a public
 * link, which this card never renders on). So once turning membership on is applied — confirmed here, in General, or by the
 * host's Apply now: confirmedWrite follows it to the end either way, then this card reads it again — the Connect card loads
 * with its address and code fields, and no reload is asked for. Nothing has loaded the Hub client before (no Hub module loads
 * on an unmarked page), so it starts as the member client. Presentation only: a mark confers no authority.
 */
const markMember = on => {
  const body = globalThis.document?.body;
  if (!body || markedMember() === on) return;
  const tokens = String(body.dataset.hub || "").split(/\s+/).filter(t => t && t !== "member");
  if (on) tokens.push("member");
  if (tokens.length) body.dataset.hub = tokens.join(" "); else delete body.dataset.hub;
};
export function HubMembershipSettings() {
  const publicPage = globalThis.document?.body?.dataset?.publicLink === "1";
  const [view, setView] = useState(null), [busy, setBusy] = useState(false), [messageKey, setMessageKey] = useState("loading");
  const [Connect, setConnect] = useState(null);
  const [connectError, setConnectError] = useState(false), [attempt, setAttempt] = useState(0);
  const owner = useRef({ mounted: true, seq: 0, busy: false });
  const read = async () => {
    const seq = ++owner.current.seq;
    if (!view) setMessageKey("loading");
    let result; try { result = await api(path); } catch { result = null; }
    if (!owner.current.mounted || owner.current.seq !== seq) return;
    if (result?.ok && typeof result.body?.enabled === "boolean") { markMember(result.body.enabled); setView({ enabled: result.body.enabled }); setMessageKey(""); }
    else { setView(null); setMessageKey("unavailable"); }
  };
  useEffect(() => {
    owner.current.mounted = true;
    if (!publicPage) read();
    return () => { owner.current.mounted = false; owner.current.seq++; };
  }, [publicPage]);
  useEffect(() => {
    let live = true;
    if (!publicPage && view?.enabled && markedMember()) {
      setConnectError(false);
      import("./settings-hub.js").then(m => { if (live) setConnect(() => m.HubConnectCard); }, () => { if (live) setConnectError(true); });
    }
    return () => { live = false; };
  }, [publicPage, view?.enabled, attempt]);
  const change = async enabled => {
    if (publicPage || !view || owner.current.busy) return;
    owner.current.busy = true; owner.current.seq++; setBusy(true); setMessageKey("");
    try {
      const result = await confirmedWrite(path, { method: "PUT", body: { enabled }, label: copy("title"),
        onPending: () => { if (owner.current.mounted) setMessageKey("pending"); } });
      if (!owner.current.mounted) return;
      if (result.ok) await read();
      else { setView(null); setMessageKey("failed"); }
    } catch { if (owner.current.mounted) { setView(null); setMessageKey("failed"); } }
    finally { owner.current.busy = false; if (owner.current.mounted) setBusy(false); }
  };
  if (publicPage) return null;
  return html`<div class="form hub-membership-settings"><section class="card" id="hub-membership">
    <h3>${copy("title")}</h3><p class="note">${copy("hint")}</p>
    ${!view && messageKey === "loading" ? html`<${Skeleton} variant="rows" lines=${2} label=${copy("loading")} />` : html`<label class="check"><input id="hubMemberEnabled" class="s-ui-toggle" type="checkbox" role="switch" checked=${view?.enabled === true}
      disabled=${!view || busy} onChange=${e => change(e.target.checked)} /><span>${copy("enabled")}</span></label>`}
    <p class="note">${copy("off")}</p>
    ${messageKey && messageKey !== "loading" ? html`<p role="status">${copy(messageKey)}</p>` : null}
    ${!view && !busy && messageKey !== "loading" ? html`<button class="btn btn-sm" type="button" onClick=${read}>${copy("retry")}</button>` : null}
  </section>${view?.enabled && markedMember() ? Connect ? html`<${Connect} />` : connectError ? html`<${ErrorState} message=${copy("unavailable")} onRetry=${() => setAttempt(n => n + 1)} />` : html`<${Skeleton} variant="form" lines=${4} />` : null}</div>`;
}
