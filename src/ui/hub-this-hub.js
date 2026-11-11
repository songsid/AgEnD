// M-2682: Hub Administration → This Hub, for the Hub's configured administrator. What this Hub is (read-only: its name, Hub ID,
// the member key fingerprint members compare when they pair, the issuer key id and the AgEnD version) and its name, changed
// or removed here instead of in the host's configuration (721ca0c3). How it was installed (hub.coexistence) is shown, not edited. The server reseals the Hub's settings with its own key
// and reloads the Hub with the new name; this card then reloads the page so the brand shows it. One click, no extra dialog:
// a name is not a security decision. Its own lazy module with its own words, so an older tab or server simply leaves it out.
// Shared components: card, field, btn, note, err, Skeleton.
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { Skeleton } from "/assets/ui-states.js";
import { toast } from "/assets/ui-toast.js";
import { hubClient, compareGroups } from "./hub-client.js";

register("hubThisHub", {
  en: {
    directoryOpen: "Edit AD connection", title: "This Hub", lead: "Its name is shown on the sign-in page and when you point at AgEnD Hub in the sidebar. The rest identifies this Hub and can't be changed here.",
    name: "Hub name", noName: "No name", namePlaceholder: "No name: shown as AgEnD Hub", nameHint: "Up to 64 characters.",
    save: "Save name", removeName: "Remove name", saving: "Saving…",
    saved: "Saved. The Hub is reloading with its new name.", removed: "Name removed. The Hub is reloading.",
    hubId: "Hub ID", memberKey: "Member key fingerprint", memberKeyHint: "People compare this when they connect a fleet with a pairing code.",
    issuerKey: "Issuer key", version: "AgEnD version", unknown: "Unknown",
    install: "Installed as", install_dedicated: "Dedicated: this computer runs only the Hub", "install_same-user-pilot": "Beside a fleet, under the same user",
    installHint: "Chosen when the Hub was set up.",
    err_invalid: "Use 1 to 64 characters, without line breaks or control characters.",
    err_unchanged: "That is already this Hub's name.",
    err_stale: "The Hub's settings changed meanwhile. Check the name and save again.",
    err_expired: "That took too long. Save again.",
    err_busy: "Another change to the Hub's settings is still finishing. Try again in a moment.",
    err_denied: "Only this Hub's administrator can rename it. Sign in again and retry.",
    err_unavailable: "The Hub's settings can't be changed right now. Reload this page and try again.",
    err_recovery: "The rename didn't finish. Reload this page to see the Hub's current name, then try again if it's not the one you want.",
    err_failed: "The name wasn't saved. Try again.",
  },
  "zh-TW": {
    directoryOpen: "編輯 AD 連線", title: "這個 Hub", lead: "名稱會顯示在登入頁，滑鼠移到側邊欄的 AgEnD Hub 上也會看到。其餘資料用來識別這個 Hub，不能在這裡變更。",
    name: "Hub 名稱", noName: "沒有名稱", namePlaceholder: "沒有名稱：顯示為 AgEnD Hub", nameHint: "最多 64 個字元。",
    save: "儲存名稱", removeName: "移除名稱", saving: "儲存中…",
    saved: "已儲存。Hub 正在以新名稱重新載入。", removed: "已移除名稱。Hub 正在重新載入。",
    hubId: "Hub ID", memberKey: "成員金鑰指紋", memberKeyHint: "有人用配對碼把 Fleet 連接到這個 Hub 時，會比對這組指紋。",
    issuerKey: "簽發金鑰", version: "AgEnD 版本", unknown: "不明",
    install: "安裝方式", install_dedicated: "專用：這台電腦只執行 Hub", "install_same-user-pilot": "與 Fleet 共用同一個使用者",
    installHint: "在設定 Hub 時選定。",
    err_invalid: "請輸入 1 到 64 個字元，不能有換行或控制字元。",
    err_unchanged: "這已經是這個 Hub 的名稱。",
    err_stale: "Hub 的設定剛剛有變更。請確認名稱後再儲存一次。",
    err_expired: "等候太久了，請再儲存一次。",
    err_busy: "Hub 設定的另一項變更還在完成中，請稍後再試。",
    err_denied: "只有這個 Hub 的管理員可以改名。請重新登入後再試。",
    err_unavailable: "目前無法變更 Hub 的設定。請重新載入這個頁面後再試。",
    err_recovery: "改名沒有完成。請重新載入這個頁面查看 Hub 目前的名稱，如果不是你要的名稱再試一次。",
    err_failed: "名稱沒有儲存，請再試一次。",
  },
});
const ht = (k, ...a) => t(`hubThisHub.${k}`, ...a);
const INSTALL = new Set(["dedicated", "same-user-pilot"]);
const ERR = new Set(["invalid", "unchanged", "stale", "expired", "busy", "denied", "unavailable", "recovery"]);
const errText = (r) => ht(`err_${ERR.has(r.code) ? r.code : "failed"}`);

/** After a rename the Hub reloads itself; wait until it answers with the new name, then reload this page (its brand). */
async function reloadWhenRenamed(name, { tries = 30, every = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, every));
    try {
      const r = await fetch("/hub/v1/session", { credentials: "same-origin", cache: "no-store" });
      if (r.ok) { const s = await r.json(); if ((s?.hub?.name || null) === name) break; }
    } catch { /* the Hub is restarting */ }
  }
  location.reload();
}

export function ThisHubCard({ directory = false } = {}) {
  const client = hubClient();
  const [info, setInfo] = useState(undefined);            // undefined: reading; null: not offered here
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    if (!client || client.thisHubV1 !== true) { setInfo(null); return; }
    client.thisHub().then((r) => { if (!live) return; if (r.ok) { setInfo(r); setDraft(r.name || ""); } else setInfo(null); });
    return () => { live = false; };
  }, []);
  if (info === null) return null;
  if (info === undefined) return html`<section class="card hub-this-hub"><h3>${ht("title")}</h3><${Skeleton} variant="rows" lines=${3} /></section>`;
  const save = async (name) => {
    setBusy(true); setError("");
    const p = await client.prepareHubName(name);
    const c = p.ok ? await client.commitHubName(p.ref) : p;
    if (!c.ok) { setBusy(false); setError(errText(c)); return; }
    toast(ht(name === null ? "removed" : "saved"));
    reloadWhenRenamed(name);
  };
  const typed = draft.trim(), current = info.name || "";
  // The Hub's name shows here in plain sight (the sidebar's brand carries it only as its tooltip — the leader on Argon #18).
  return html`<section class="card hub-this-hub" data-section="this-hub"><div class="hub-card-head"><h3>${ht("title")}</h3><span class="s-scope" data-hub-name=${current ? "set" : "none"}>${current || ht("noName")}</span></div><p class="note">${ht("lead")}</p>
    ${info.rename ? html`<form class="hub-this-form" onSubmit=${(e) => { e.preventDefault(); if (typed && typed !== current) save(typed); }}>
      <label class="field"><span>${ht("name")}</span><input id="hubThisName" maxlength="64" autocomplete="off" placeholder=${ht("namePlaceholder")} value=${draft} disabled=${busy}
        onInput=${(e) => { setDraft(e.target.value); setError(""); }} /><small class="note">${ht("nameHint")}</small></label>
      <div class="hub-this-actions">
        <button type="submit" class="btn btn-primary" disabled=${busy || !typed || typed === current}>${busy ? ht("saving") : ht("save")}</button>
        ${current ? html`<button type="button" class="btn" disabled=${busy} onClick=${() => save(null)}>${ht("removeName")}</button>` : null}
      </div>
    </form>` : html`<div class="field"><span>${ht("name")}</span><span>${current || ht("namePlaceholder")}</span></div>`}
    ${error ? html`<p class="err" role="alert">${error}</p>` : null}
    ${directory ? html`<div class="s-row"><a class="btn" href="/ui/hub/admin?view=directory">${ht("directoryOpen")}</a></div>` : null}
    <dl class="hub-this-facts">
      <dt>${ht("hubId")}</dt><dd><code>${info.hubId}</code></dd>
      <dt>${ht("memberKey")}</dt><dd><code class="hub-fp-groups" title=${info.memberSpkiSha256}>${compareGroups(info.memberSpkiSha256)}</code><small class="note">${ht("memberKeyHint")}</small></dd>
      <dt>${ht("issuerKey")}</dt><dd><code>${info.issuerKeyId}</code></dd>
      <dt>${ht("version")}</dt><dd>${info.version || ht("unknown")}</dd>
      ${info.coexistence ? html`<dt>${ht("install")}</dt><dd>${INSTALL.has(info.coexistence) ? ht(`install_${info.coexistence}`) : html`<code>${info.coexistence}</code>`}<small class="note">${ht("installHint")}</small></dd>` : null}
    </dl>
  </section>`;
}
