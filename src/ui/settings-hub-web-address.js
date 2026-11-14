// M-2901 / #3428: fleet Settings → Hub → "Hub address", for this computer's host owner (the page mark below; the server's D3
// proof decides). The address people enter in AgEnD Settings → Hub and open in their browser. One field; where the Hub
// listens and which certificate it uses follow from it, and can be set under Advanced. Check (prepare) shows what changes,
// then one Confirm: everyone signs in to the Hub's pages again, connected Fleets stay connected (their member address,
// pins and credentials are untouched — #3429 is the member address). Own lazy module with its own words, so an older tab
// or server simply leaves it out. Shared components: card, field, btn, note, err, s-web-ro, s-ui-disclosure, Skeleton.
import { html, useEffect, useState } from "/assets/app-html.js";
import { Skeleton } from "/assets/ui-states.js";
import { register, t, lang } from "/assets/app-i18n.js";
import { api } from "./settings-confirm.js";

register("hubWebAddress", {
  en: {
    title: "Hub address",
    lead: "The address colleagues enter in AgEnD Settings → Hub and open in their browser.",
    address: "Address", listens: "Listens on", certificate: "Certificate", expires: "expires {0}", selfSigned: "Self-signed",
    change: "Change address", newAddress: "New address", newHint: "https:// is added for you. If the port isn't 443, add a colon and the port number, for example :8443.",
    advanced: "Advanced", listenHost: "Listen on (interface)", listenPort: "Port",
    listenHint: "Where the Hub listens on this computer. Usually the address's own port; change it only if a router or reverse proxy forwards another port.",
    cert_keep: "Keep the current certificate", cert_generate: "Create a self-signed certificate for the new address",
    cert_import: "Use my own certificate", certPem: "Certificate (PEM)", keyPem: "Private key (PEM)",
    importHint: "Paste the PEM text. The certificate must cover the new address. The key is sent once to this computer and never shown again.",
    check: "Check", checking: "Checking…", cancel: "Cancel", back: "Back",
    confirmTitle: "Change the Hub's address?", from: "From", to: "To",
    effect: "Everyone signs in to the Hub's pages again, you too. The old address stops working. Connected Fleets stay connected and don't need to connect again.",
    selfSignedWarn: "Self-signed: browsers warn until it is trusted. Compare this fingerprint before trusting it.",
    confirm: "Confirm change", saving: "Changing…",
    ready: "Done. The Hub now answers at {0}. Sign in there again.", open: "Open the Hub",
    off: "Saved. The Hub is stopped; it uses the new address when it runs again.",
    saved_unavailable: "Saved, but the Hub doesn't answer at the new address yet. Check that nothing else uses port {0} on this computer, then turn Run this Hub off and on. The old address no longer works.",
    err_invalid: "That isn't a usable address. Use an https address such as hub.example.com, and a port from 1 to 65535.",
    err_port_conflict: "That address or port is the one Fleets connect to. Use a different port.",
    err_port_in_use: "Another program on this computer is using that port. Choose another port under Advanced.",
    err_certificate: "The certificate doesn't fit: it must cover the new address, match its private key and still be valid. Or create a new one under Advanced.",
    err_unchanged: "That is already the Hub's address.",
    err_stale: "The Hub's settings changed meanwhile. Check the address and try again.",
    err_expired: "That took too long. Check again.",
    err_busy: "Another settings change is still in progress. Try again in a moment.",
    err_joining: "A colleague's Fleet is joining this Hub right now, so the Hub address can't be changed. Try again after {0}.",
    err_joining_no_time: "A colleague's Fleet is joining this Hub right now, so the Hub address can't be changed. Try again in a few minutes.",
    err_denied: "Only this computer's own dashboard can change the Hub's address. Reload this page and try again.",
    err_unavailable: "The Hub's address can't be changed right now. Reload this page and try again.",
    err_recovery: "The change didn't finish. Reload this page to see the Hub's current address.",
    err_failed: "The address wasn't changed. Try again.",
  },
  "zh-TW": {
    title: "Hub 位址",
    lead: "同仁在 AgEnD 設定 → Hub 輸入、並用瀏覽器開啟的位址。",
    address: "位址", listens: "監聽於", certificate: "憑證", expires: "到期日 {0}", selfSigned: "自簽",
    change: "變更位址", newAddress: "新位址", newHint: "會自動加上 https://。如果連接埠不是 443，請加上冒號和連接埠號碼，例如 :8443。",
    advanced: "進階", listenHost: "監聽介面", listenPort: "連接埠",
    listenHint: "Hub 在這台電腦上監聽的位置。通常就是位址本身的連接埠；只有路由器或反向代理轉送其他連接埠時才需要變更。",
    cert_keep: "沿用目前的憑證", cert_generate: "為新位址建立自簽憑證",
    cert_import: "使用我自己的憑證", certPem: "憑證（PEM）", keyPem: "私鑰（PEM）",
    importHint: "貼上 PEM 文字。憑證必須涵蓋新位址。私鑰只會傳送到這台電腦一次，之後不會再顯示。",
    check: "檢查", checking: "檢查中…", cancel: "取消", back: "返回",
    confirmTitle: "要變更 Hub 的位址嗎？", from: "原位址", to: "新位址",
    effect: "變更後，所有人（包括你）都要重新登入 Hub 網頁，舊位址也會停止運作。已連接的 Fleet 會保持連接，不需要重新連接。",
    selfSignedWarn: "自簽憑證：在設定信任之前，瀏覽器會顯示警告。信任前請先核對這組指紋。",
    confirm: "確認變更", saving: "變更中…",
    ready: "完成。Hub 現在使用 {0}，請在那裡重新登入。", open: "開啟 Hub",
    off: "已儲存。Hub 目前已停止，再次執行時會使用新位址。",
    saved_unavailable: "已儲存，但 Hub 還沒有在新位址回應。請確認這台電腦上沒有其他程式使用 {0} 埠，再將「執行這個 Hub」關閉後重新開啟。舊位址已停止運作。",
    err_invalid: "這不是可用的位址。請使用像 hub.example.com 這樣的 https 位址，連接埠為 1 到 65535。",
    err_port_conflict: "這個位址或連接埠是 Fleet 連接 Hub 用的，請改用其他連接埠。",
    err_port_in_use: "這台電腦上有其他程式正在使用這個連接埠。請在「進階」選擇其他連接埠。",
    err_certificate: "憑證不符：必須涵蓋新位址、與私鑰相符，而且尚未過期。也可以在「進階」建立新的憑證。",
    err_unchanged: "這已經是 Hub 目前的位址。",
    err_stale: "Hub 的設定剛剛有變更。請確認位址後再試一次。",
    err_expired: "等候太久了，請再檢查一次。",
    err_busy: "另一項設定變更還在進行，請稍候再試。",
    err_joining: "有同仁的 Fleet 正在加入這個 Hub，這段時間不能變更 Hub 位址。請在 {0} 之後再試一次。",
    err_joining_no_time: "有同仁的 Fleet 正在加入這個 Hub，這段時間不能變更 Hub 位址。請過幾分鐘再試一次。",
    err_denied: "只有這台電腦自己的儀表板可以變更 Hub 的位址。請重新載入這個頁面後再試。",
    err_unavailable: "目前無法變更 Hub 的位址。請重新載入這個頁面後再試。",
    err_recovery: "變更沒有完成。請重新載入這個頁面查看 Hub 目前的位址。",
    err_failed: "位址沒有變更，請再試一次。",
  },
});
const copy = (key, ...a) => t(`hubWebAddress.${key}`, ...a);
const PREFIX = "/api/settings/hub/web-address";
const ERR = new Set(["invalid", "port_conflict", "port_in_use", "certificate", "unchanged", "stale", "expired", "busy", "denied", "unavailable", "recovery"]);
const errKey = (code) => `err_${ERR.has(code) ? code : "failed"}`;
const errorText = (r) => {
  if (r.code !== "joining") return copy(errKey(r.code));
  let time = "";
  if (Number.isSafeInteger(r.retryAt) && r.retryAt > 0) {
    try {
      // Round up: the displayed minute must not invite a retry before the exact deadline.
      const at = new Date(Math.ceil(r.retryAt / 60_000) * 60_000);
      if (!Number.isNaN(at.getTime())) time = new Intl.DateTimeFormat(lang(), { hour: "2-digit", minute: "2-digit" }).format(at);
    } catch { /* The no-time wording also supports an older response or browser. */ }
  }
  return copy(time ? "err_joining" : "err_joining_no_time", time);
};

/** What was typed, as the https origin the server is asked for ("hub.example.com" → "https://hub.example.com"); null if not one. */
export function typedOrigin(text) {
  const v = String(text || "").trim();
  if (!v) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
    return u.protocol === "https:" && u.hostname ? u.origin : null;
  } catch { return null; }
}
const portOf = (origin) => { try { const u = new URL(origin); return u.port ? Number(u.port) : 443; } catch { return null; } };
const hostOf = (origin) => { try { return new URL(origin).hostname; } catch { return ""; } };
/** The display form of an origin: no https://, no :443. */
export const shownAddress = (origin) => String(origin || "").replace(/^https:\/\//, "").replace(/:443$/, "");

/**
 * Where the Hub should listen for a new address. Today's interface stays; the port follows the address — unless today's port
 * is not the address's own (a router or proxy forwards it), and then it stays as it is.
 */
export function defaultListen(current, origin) {
  const forwarded = current?.listen && portOf(current.origin) !== current.listen.port;
  return { host: current?.listen?.host || "0.0.0.0", port: forwarded ? current.listen.port : (portOf(origin) ?? current?.listen?.port ?? 443) };
}

export function createWebAddressClient() {
  const call = async (action, body) => {
    try {
      const r = await api(PREFIX + action, { credentials: "same-origin", cache: "no-store", ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
      return r.ok && r.body?.ok ? r.body : { ok: false, code: r.body?.code || "unavailable", ...(Number.isSafeInteger(r.body?.retryAt) ? { retryAt: r.body.retryAt } : {}) };
    } catch { return { ok: false, code: "unavailable" }; }
  };
  return { read: () => call(""), prepare: (candidate) => call("/prepare", candidate), commit: (ref) => call("/commit", { ref }) };
}

/** A certificate's end date in the page's language ("Nov 13, 2027" / 「2027年11月13日」); the server's own text if it isn't a date. */
export function shownDate(validTo) {
  const d = new Date(String(validTo || ""));
  if (Number.isNaN(d.getTime())) return String(validTo || "");
  try { return new Intl.DateTimeFormat(lang(), { dateStyle: "medium" }).format(d); } catch { return d.toISOString().slice(0, 10); }
}
function Fingerprint({ info }) {
  if (!info?.fingerprint256) return null;
  // People compare it byte by byte: a line may break only after a colon, never inside a byte.
  const parts = String(info.fingerprint256).split(":");
  return html`<code class="hub-addr-fp">${parts.map((p, i) => (i ? [":", html`<wbr />`, p] : p))}</code>${info.validTo ? html` <small class="note hub-addr-exp">${copy("expires", shownDate(info.validTo))}</small>` : null}${info.selfSigned ? html` <span class="tag">${copy("selfSigned")}</span>` : null}`;
}

export function HubWebAddressSettings({ client: given = null } = {}) {
  const [client] = useState(() => given || createWebAddressClient());
  const [view, setView] = useState(undefined);          // undefined: reading; null: not offered; else { origin, listen, certificate }
  const [step, setStep] = useState("show");             // show | edit | confirm | done
  const [typed, setTyped] = useState(""), [host, setHost] = useState(""), [port, setPort] = useState(""), [cert, setCert] = useState(null);
  const [touched, setTouched] = useState(false);        // Advanced was changed by hand: the address no longer re-derives it
  const [certPem, setCertPem] = useState(""), [keyPem, setKeyPem] = useState("");
  const [proposal, setProposal] = useState(null), [outcome, setOutcome] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    client.read().then((r) => { if (live) setView(r.ok && typeof r.origin === "string" ? r : r.code === "denied" ? null : { failed: true }); });
    return () => { live = false; };
  }, []);
  if (view === null) return null;
  const head = html`<h3>${copy("title")}</h3><p class="note">${copy("lead")}</p>`;
  if (view === undefined) return html`<section class="card hub-web-address" data-section="hub-address">${head}<${Skeleton} variant="rows" lines=${3} /></section>`;
  if (view.failed) return html`<section class="card hub-web-address" data-section="hub-address">${head}<p class="err" role="alert">${copy("err_unavailable")}</p></section>`;

  const origin = typedOrigin(typed);
  const listen = touched ? { host: host.trim(), port: Number(port) } : defaultListen(view, origin || view.origin);
  const sameHost = !!origin && hostOf(origin) === hostOf(view.origin);
  // Today's certificate unless the address names another host (it only fits today's host name): then a new self-signed one,
  // or the person's own under Advanced. A hand-picked "keep" falls back the same way.
  const picked = touched && cert ? cert : "keep";
  const mode = picked === "keep" && origin && !sameHost ? "generate" : picked;
  const touch = () => { if (!touched) { setTouched(true); setHost(listen.host); setPort(String(listen.port)); setCert(mode); } };
  const edit = () => { setStep("edit"); setTyped(""); setTouched(false); setCert(null); setCertPem(""); setKeyPem(""); setError(""); setOutcome(null); };
  const check = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    if (!origin || !Number.isInteger(listen.port) || listen.port < 1 || listen.port > 65535 || !listen.host) { setError(copy("err_invalid")); return; }
    if (origin === view.origin && listen.host === view.listen?.host && listen.port === view.listen?.port && mode === "keep") { setError(copy("err_unchanged")); return; }
    setBusy(true); setError("");
    const certificate = mode === "import" ? { mode, certPem, keyPem } : { mode };
    const r = await client.prepare({ origin, listen, certificate });
    setBusy(false);
    if (!r.ok) { setError(errorText(r)); return; }
    setKeyPem("");                                        // sent once; never kept in the page
    setProposal(r); setStep("confirm");
  };
  const confirm = async () => {
    if (busy || !proposal) return;
    setBusy(true); setError("");
    const r = await client.commit(proposal.ref);
    setBusy(false);
    if (!r.ok) { setError(errorText(r)); if (r.code === "expired" || r.code === "stale" || r.code === "joining") { setProposal(null); setStep("edit"); } return; }
    setOutcome(r); setProposal(null); setStep("done");
    setView((v) => ({ ...v, origin: r.origin || proposal.summary?.to, listen: proposal.summary?.listen || v.listen, certificate: proposal.certificate || v.certificate }));
  };
  const current = html`<dl class="s-web-ro hub-addr-now">
    <dt>${copy("address")}</dt><dd><a href=${view.origin} target="_blank" rel="noopener noreferrer">${shownAddress(view.origin)}</a></dd>
    ${view.listen ? html`<dt>${copy("listens")}</dt><dd><code>${view.listen.host}:${view.listen.port}</code></dd>` : null}
    ${view.certificate ? html`<dt>${copy("certificate")}</dt><dd><${Fingerprint} info=${view.certificate} /></dd>` : null}
  </dl>`;
  const err = error ? html`<p class="err" role="alert">${error}</p>` : null;

  if (step === "confirm" && proposal) {
    const s = proposal.summary || {};
    return html`<section class="card hub-web-address" data-section="hub-address">${head}
      <div class="hub-addr-confirm" role="group" aria-label=${copy("confirmTitle")}><h4>${copy("confirmTitle")}</h4>
        <dl class="s-web-ro">
          <dt>${copy("from")}</dt><dd>${shownAddress(s.from)}</dd>
          <dt>${copy("to")}</dt><dd><strong>${shownAddress(s.to)}</strong></dd>
          ${s.listen ? html`<dt>${copy("listens")}</dt><dd><code>${s.listen.host}:${s.listen.port}</code></dd>` : null}
          ${proposal.certificate ? html`<dt>${copy("certificate")}</dt><dd><${Fingerprint} info=${proposal.certificate} /></dd>` : null}
        </dl>
        ${proposal.certificate?.selfSigned && mode !== "keep" ? html`<p class="note">${copy("selfSignedWarn")}</p>` : null}
        <p class="note hub-addr-effect">${copy("effect")}</p>
        <div class="s-row">
          <button type="button" class="btn btn-primary" disabled=${busy} onClick=${confirm}>${busy ? copy("saving") : copy("confirm")}</button>
          <button type="button" class="btn" disabled=${busy} onClick=${() => { setProposal(null); setStep("edit"); setError(""); }}>${copy("back")}</button>
        </div>
      </div>${err}</section>`;
  }
  if (step === "edit") {
    return html`<section class="card hub-web-address" data-section="hub-address">${head}${current}
      <form class="form hub-addr-form" onSubmit=${check}>
        <label class="field"><span>${copy("newAddress")}</span><input id="hubAddrNew" autocomplete="off" inputmode="url" placeholder="hub.example.com" value=${typed} disabled=${busy}
          onInput=${(e) => { setTyped(e.target.value); setError(""); }} /><small class="note">${copy("newHint")}</small></label>
        <details class="s-ui-disclosure hub-addr-advanced"><summary>${copy("advanced")}</summary><div class="s-ui-disclosure-body">
          <div class="grid2">
            <label class="field"><span>${copy("listenHost")}</span><input id="hubAddrHost" autocomplete="off" value=${listen.host} disabled=${busy} onInput=${(e) => { touch(); setHost(e.target.value); setError(""); }} /></label>
            <label class="field"><span>${copy("listenPort")}</span><input id="hubAddrPort" type="number" inputmode="numeric" min="1" max="65535" step="1" value=${String(listen.port)} disabled=${busy}
              onInput=${(e) => { touch(); setPort(e.target.value); setError(""); }} /></label>
          </div>
          <small class="note">${copy("listenHint")}</small>
          <fieldset class="field hub-addr-cert"><legend>${copy("certificate")}</legend>
            ${(sameHost || !origin ? ["keep", "generate", "import"] : ["generate", "import"]).map((m) => html`<label class="check"><input type="radio" name="hubAddrCert" value=${m} checked=${mode === m} disabled=${busy}
              onChange=${() => { touch(); setCert(m); setError(""); }} /> ${copy(`cert_${m}`)}</label>`)}
            ${mode === "import" ? html`<label class="field"><span>${copy("certPem")}</span><textarea id="hubAddrCertPem" rows="4" spellcheck=${false} value=${certPem} disabled=${busy} onInput=${(e) => setCertPem(e.target.value)}></textarea></label>
              <label class="field"><span>${copy("keyPem")}</span><textarea id="hubAddrKeyPem" rows="4" spellcheck=${false} autocomplete="off" value=${keyPem} disabled=${busy} onInput=${(e) => setKeyPem(e.target.value)}></textarea></label>
              <small class="note">${copy("importHint")}</small>` : null}
          </fieldset>
        </div></details>
        <div class="s-row">
          <button type="submit" class="btn btn-primary" disabled=${busy || !typed.trim() || (mode === "import" && (!certPem.trim() || !keyPem.trim()))}>${busy ? copy("checking") : copy("check")}</button>
          <button type="button" class="btn" disabled=${busy} onClick=${() => { setStep("show"); setError(""); }}>${copy("cancel")}</button>
        </div>
      </form>${err}</section>`;
  }
  const done = outcome ? html`<p role="status" class=${outcome.state === "saved_unavailable" ? "err" : "note"}>${outcome.state === "ready" ? copy("ready", shownAddress(outcome.origin))
    : outcome.state === "off" ? copy("off") : copy("saved_unavailable", String(view.listen?.port ?? ""))}</p>
` : null;
  // One row: Open the Hub (after a change that is ready) beside Change address.
  return html`<section class="card hub-web-address" data-section="hub-address">${head}${current}${done}
    <div class="s-row">${outcome?.state === "ready" ? html`<a class="btn btn-primary" href=${outcome.origin} target="_blank" rel="noopener noreferrer">${copy("open")}</a>` : null}<button type="button" class="btn" id="hubAddrChange" onClick=${edit}>${copy("change")}</button></div>${err}</section>`;
}
