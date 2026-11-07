import { Skeleton } from "/assets/ui-states.js";
// Lazy host-only card. Own every string so a retained Settings shell can load this newer card.
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { api, confirmedWrite } from "./settings-confirm.js";
register("hubBrowserCertificate", {
  en: {
    title: "Hub browser certificate", fingerprint: "SHA-256 fingerprint", expires: "Expires", generate: "Generate self-signed certificate",
    import: "Import a certificate and private key", certificateFile: "Certificate file", keyFile: "Private key file",
    hint: "File paths are relative to the AgEnD home on the Hub computer. Both files and their parent directories must be private to its owner. The certificate must cover the Hub web address.",
    boundary: "This changes browser HTTPS only. Member pairing and its transport certificate stay the same.",
    prepare: "Prepare replacement", replace: "Confirm replacement", saved: "Browser certificate replaced. New connections use it.",
    restart: "The replacement is saved. Restart the Hub to activate it.",
    selfSigned: "Self-signed certificate: browsers will warn unless you trust it separately. Confirm the fingerprint before trusting it.",
    failed: "The certificate could not be prepared or saved. Check the private file paths, key match, web hostname and expiry, or that OpenSSL is installed for generation. Reload and try again.",
    conflict: "The certificate or proposal changed or expired. Reload and prepare it again.",
    unavailable: "Start the initialized Hub to view or replace its browser certificate.",
  },
  "zh-TW": {
    title: "Hub 瀏覽器憑證", fingerprint: "SHA-256 指紋", expires: "到期時間", generate: "產生新的自簽憑證",
    import: "匯入憑證與私鑰", certificateFile: "憑證檔案", keyFile: "私鑰檔案",
    hint: "檔案路徑相對於 Hub 電腦上的 AgEnD 主目錄。兩個檔案及其上層目錄都必須僅供擁有者存取；憑證必須涵蓋 Hub 網址。",
    boundary: "這只會變更瀏覽器 HTTPS；成員配對及其傳輸憑證保持不變。",
    prepare: "準備替換憑證", replace: "確認替換", saved: "已替換瀏覽器憑證；新連線會使用新憑證。",
    restart: "已儲存替換憑證，請重新啟動 Hub 以套用。",
    selfSigned: "自簽憑證：除非另外設定信任，否則瀏覽器會顯示警告。請先核對指紋再信任。",
    failed: "無法準備或儲存憑證。請檢查私有檔案路徑、私鑰是否相符、網址主機名稱與到期時間；產生憑證需要安裝 OpenSSL。請重新整理後再試。",
    conflict: "憑證或提案已變更或過期，請重新整理後重新準備。", unavailable: "請先啟動已初始化的 Hub，再查看或替換瀏覽器憑證。",
  },
});
const copy = key => t(`hubBrowserCertificate.${key}`), path = "/api/settings/hub/browser-certificate";
export function HubBrowserCertificateSettings() {
  const [view, setView] = useState(null), [mode, setMode] = useState("generate"), [certFile, setCertFile] = useState(""), [keyFile, setKeyFile] = useState("");
  const [proposal, setProposal] = useState(null), [busy, setBusy] = useState(false), [messageKey, setMessageKey] = useState("");
  useEffect(() => {
    let live = true;
    api(path).then(r => { if (live) { if (r.ok && r.body?.certificate) setView(r.body.certificate); else setMessageKey("unavailable"); } },
      () => { if (live) setMessageKey("unavailable"); });
    return () => { live = false; };
  }, []);
  const fail = r => setMessageKey(r?.body?.error === "conflict" ? "conflict" : "failed");
  const prepare = async e => {
    e.preventDefault(); if (!view || busy) return;
    setBusy(true); setProposal(null); setMessageKey("");
    try {
      const body = { mode, revision: view.revision, ...(mode === "import" ? { certificateFile: certFile, keyFile } : {}) };
      const r = await api(`${path}/prepare`, { method: "POST", body: JSON.stringify(body) });
      if (r.ok && r.body?.proposal) setProposal(r.body.proposal); else fail(r);
    } catch { fail(); } finally { setBusy(false); }
  };
  const replace = async () => {
    if (!proposal || busy) return;
    setBusy(true); setMessageKey("");
    try {
      const r = await confirmedWrite(`${path}/apply`, { method: "POST", label: copy("title"), body: { reference: proposal.reference, revision: proposal.revision } });
      if (r.ok && r.body?.certificate) { setView(r.body.certificate); setProposal(null); setMessageKey(r.body.certificate.restartRequired ? "restart" : "saved"); }
      else fail(r);
    } catch { fail(); } finally { setBusy(false); }
  };
  const details = info => html`<dl class="s-web-ro"><dt>${copy("fingerprint")}</dt><dd>${info.fingerprint256}</dd><dt>${copy("expires")}</dt><dd>${info.validTo}</dd></dl>`;
  return html`<section class="card hub-browser-certificate"><h3>${copy("title")}</h3><p class="note">${copy("boundary")}</p>
    ${!view && !messageKey ? html`<${Skeleton} variant="form" lines=${4} />` : null}
    ${view ? html`${details(view.selected)}${view.restartRequired ? html`<p role="status">${copy("restart")}</p>` : null}
      <form class="form" onSubmit=${prepare}><label class="field"><select aria-label=${copy("title")} value=${mode} disabled=${busy} onChange=${e => { setMode(e.target.value); setProposal(null); }}>
        <option value="generate">${copy("generate")}</option><option value="import">${copy("import")}</option></select></label>
        ${mode === "import" ? html`<p class="note">${copy("hint")}</p><div class="grid2">
          <label class="field">${copy("certificateFile")}<input value=${certFile} disabled=${busy} onInput=${e => { setCertFile(e.target.value); setProposal(null); }} /></label>
          <label class="field">${copy("keyFile")}<input value=${keyFile} disabled=${busy} onInput=${e => { setKeyFile(e.target.value); setProposal(null); }} /></label>
        </div>` : null}
        <button class="btn" disabled=${busy || (mode === "import" && (!certFile || !keyFile))}>${copy("prepare")}</button>
      </form>` : null}
    ${proposal ? html`<div class="hub-certificate-proposal">${details(proposal.certificate)}${proposal.certificate.selfSigned ? html`<p role="note">${copy("selfSigned")}</p>` : null}
      <button class="btn" disabled=${busy} onClick=${replace}>${copy("replace")}</button></div>` : null}
    ${messageKey ? html`<p role="status">${copy(messageKey)}</p>` : null}
  </section>`;
}
