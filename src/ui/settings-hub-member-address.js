// #3429 (M-2901, option B): fleet Settings → Hub → "Fleet connection address", for this computer's host owner (the page
// mark; the server's D3 proof decides). Where connected Fleets reach this Hub — not the Hub address people use, which stays.
// Folded under its own disclosure: few ever change it. One field (+ where it listens, under Advanced), Check (prepare:
// the Fleets that will move are listed), one Confirm: Fleets online then follow on their own (an issuer-signed relocation);
// the rest must reconnect, and their owners get a notice. The certificate keeps its key (the server reissues its name).
// Own lazy module with its own words. Shared components: card, field, btn, note, err, s-web-ro, s-ui-disclosure, Skeleton.
import { html, useEffect, useState } from "/assets/app-html.js";
import { Skeleton } from "/assets/ui-states.js";
import { register, t } from "/assets/app-i18n.js";
import { api } from "./settings-confirm.js";
import { typedOrigin, shownAddress, defaultListen } from "./settings-hub-web-address.js";

register("hubMemberAddress", {
  en: {
    title: "Fleet connection address",
    lead: "Where connected Fleets reach this Hub. Most Hubs never change it; the Hub address colleagues use stays the same.",
    address: "Address", listens: "Listens on", fleets: "Connected Fleets", none: "None yet",
    change: "Change connection address", newAddress: "New connection address", newHint: "https:// is added for you. If the port isn't 443, add a colon and the port number, for example :9443.",
    advanced: "Advanced", listenHost: "Listen on (interface)", listenPort: "Port",
    listenHint: "Where the Hub listens for Fleets on this computer. Usually the address's own port; change it only if a router or reverse proxy forwards another port.",
    check: "Check", checking: "Checking…", cancel: "Cancel", back: "Back",
    confirmTitle: "Change the Fleet connection address?", from: "From", to: "To",
    moving: "Fleets that move ({0})", noneMoving: "No Fleet is connected now.",
    effect: "Fleets online now follow on their own. Any that are offline lose their connection and must reconnect from their own Settings → Hub; their owners get a notice. The Hub address and sign-ins stay the same.",
    confirm: "Confirm change", saving: "Changing…",
    allFollowed: "Done. All {0} Fleets followed to the new address.", noFleets: "Done. No Fleet was connected.",
    sameKept: "Done. The address Fleets use didn't change; all {0} keep their connection.",
    connected: "Connected Fleets ({0})",
    sameEffect: "The address Fleets use doesn't change, only where the Hub listens on this computer. Connected Fleets keep their connection and reconnect on their own.",
    someFollowed: "Done. {0} of {1} Fleets followed. These must reconnect from their own Settings → Hub: {2}.",
    noneFollowed: "Done. No Fleet was online to follow. These must reconnect from their own Settings → Hub: {0}.",
    unnamed: "a Fleet without a name", sep: ", ",
    off: "Saved. The Hub is stopped; it uses the new address when it runs again.",
    saved_unavailable: "Saved, but the Hub doesn't answer at the new address yet. Check that nothing else uses port {0} on this computer, then turn Run this Hub off and on.",
    err_invalid: "That isn't a usable address. Use an https address such as hub.example.com:9443, and a port from 1 to 65535.",
    err_port_conflict: "That is the Hub address or its port. Use a different address or port for Fleets.",
    err_port_in_use: "Another program on this computer is using that port. Choose another port under Advanced.",
    err_certificate: "The Hub's connection certificate can't cover that address. Check the address and try again.",
    err_unchanged: "That is already the Fleet connection address.",
    err_stale: "Something changed meanwhile (a Fleet connected, left or was revoked). Check again.",
    err_expired: "That took too long. Check again.",
    err_busy: "Another change is still finishing, or a device is finishing its sign-in. Try again in a moment.",
    err_denied: "Only this computer's own dashboard can change it. Reload this page and try again.",
    err_unavailable: "It can't be changed right now. Reload this page and try again.",
    err_recovery: "The change didn't finish. Reload this page to see the current address.",
    err_failed: "The address wasn't changed. Try again.",
  },
  "zh-TW": {
    title: "Fleet 連接位址",
    lead: "已連接的 Fleet 連到這個 Hub 的位址。大多數 Hub 不需要變更；同仁使用的 Hub 位址不會改變。",
    address: "位址", listens: "監聽於", fleets: "已連接的 Fleet", none: "目前沒有",
    change: "變更連接位址", newAddress: "新連接位址", newHint: "會自動加上 https://。如果連接埠不是 443，請加上冒號和連接埠號碼，例如 :9443。",
    advanced: "進階", listenHost: "監聽介面", listenPort: "連接埠",
    listenHint: "Hub 在這台電腦上監聽 Fleet 連接的位置。通常就是位址本身的連接埠；只有路由器或反向代理轉送其他連接埠時才需要變更。",
    check: "檢查", checking: "檢查中…", cancel: "取消", back: "返回",
    confirmTitle: "要變更 Fleet 連接位址嗎？", from: "原位址", to: "新位址",
    moving: "會移動的 Fleet（{0}）", noneMoving: "目前沒有已連接的 Fleet。",
    effect: "目前在線上的 Fleet 會自動跟著移動。離線的 Fleet 會失去連接，需要在它自己的「設定 → Hub」重新連接，擁有者會收到通知。Hub 位址與登入狀態不變。",
    confirm: "確認變更", saving: "變更中…",
    allFollowed: "完成。全部 {0} 個 Fleet 都已跟著移動到新位址。", noFleets: "完成。目前沒有已連接的 Fleet。",
    sameKept: "完成。Fleet 使用的位址沒有變更，全部 {0} 個 Fleet 都保留連接。",
    connected: "已連接的 Fleet（{0}）",
    sameEffect: "Fleet 使用的位址不變，只變更 Hub 在這台電腦上監聽的位置。已連接的 Fleet 會保留連接，並自動重新連接。",
    someFollowed: "完成。{1} 個 Fleet 中有 {0} 個已跟著移動。以下 Fleet 需要在它自己的「設定 → Hub」重新連接：{2}。",
    noneFollowed: "完成。沒有在線上的 Fleet 可以跟著移動。以下 Fleet 需要在它自己的「設定 → Hub」重新連接：{0}。",
    unnamed: "未命名的 Fleet", sep: "、",
    off: "已儲存。Hub 目前已停止，再次執行時會使用新位址。",
    saved_unavailable: "已儲存，但 Hub 還沒有在新位址回應。請確認這台電腦上沒有其他程式使用 {0} 埠，再將「執行這個 Hub」關閉後重新開啟。",
    err_invalid: "這不是可用的位址。請使用像 hub.example.com:9443 這樣的 https 位址，連接埠為 1 到 65535。",
    err_port_conflict: "這是 Hub 位址或它的連接埠。請為 Fleet 改用其他位址或連接埠。",
    err_port_in_use: "這台電腦上有其他程式正在使用這個連接埠。請在「進階」選擇其他連接埠。",
    err_certificate: "Hub 的憑證無法涵蓋這個位址。請確認位址後再試一次。",
    err_unchanged: "這已經是目前的 Fleet 連接位址。",
    err_stale: "剛剛有變動（有 Fleet 連接、離開或被撤銷）。請再檢查一次。",
    err_expired: "等候太久了，請再檢查一次。",
    err_busy: "另一項變更還在完成中，或有裝置正在完成登入，請稍後再試。",
    err_denied: "只有這台電腦自己的儀表板可以變更。請重新載入這個頁面後再試。",
    err_unavailable: "目前無法變更。請重新載入這個頁面後再試。",
    err_recovery: "變更沒有完成。請重新載入這個頁面查看目前的位址。",
    err_failed: "位址沒有變更，請再試一次。",
  },
});
const copy = (key, ...a) => t(`hubMemberAddress.${key}`, ...a);
const PREFIX = "/api/settings/hub/member-address";
const ERR = new Set(["invalid", "port_conflict", "port_in_use", "certificate", "unchanged", "stale", "expired", "busy", "denied", "unavailable", "recovery"]);
const errKey = (code) => `err_${ERR.has(code) ? code : "failed"}`;
const names = (fleets) => (fleets || []).map((f) => f.label || copy("unnamed")).join(copy("sep"));

export function createMemberAddressClient() {
  const call = async (action, body) => {
    try {
      const r = await api(PREFIX + action, { credentials: "same-origin", cache: "no-store", ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
      return r.ok && r.body?.ok ? r.body : { ok: false, code: r.body?.code || "unavailable" };
    } catch { return { ok: false, code: "unavailable" }; }
  };
  return { read: () => call(""), prepare: (candidate) => call("/prepare", candidate), commit: (ref) => call("/commit", { ref }) };
}

/** What a finished change says: who followed, and who must reconnect (by name). */
export function outcomeText(r, port) {
  if (r.state === "off") return copy("off");
  if (r.state === "saved_unavailable") return copy("saved_unavailable", String(port ?? ""));
  const reconnect = Array.isArray(r.reconnect) ? r.reconnect : [], followed = Number(r.followed) || 0, total = followed + reconnect.length;
  if (!total) return copy("noFleets");
  if (!reconnect.length) return copy(r.sameOrigin === true ? "sameKept" : "allFollowed", String(total));
  if (!followed) return copy("noneFollowed", names(reconnect));
  return copy("someFollowed", String(followed), String(total), names(reconnect));
}

export function HubMemberAddressSettings({ client: given = null } = {}) {
  const [client] = useState(() => given || createMemberAddressClient());
  const [view, setView] = useState(undefined);          // undefined: reading; null: not offered; else { origin, listen, fleets }
  const [step, setStep] = useState("show");             // show | edit | confirm
  const [typed, setTyped] = useState(""), [host, setHost] = useState(""), [port, setPort] = useState(""), [touched, setTouched] = useState(false);
  const [proposal, setProposal] = useState(null), [outcome, setOutcome] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    client.read().then((r) => { if (live) setView(r.ok && typeof r.origin === "string" ? r : r.code === "denied" ? null : { failed: true }); });
    return () => { live = false; };
  }, []);
  if (view === null) return null;
  const head = html`<p class="note">${copy("lead")}</p>`;                // the disclosure's summary is the title
  const wrap = (body) => html`<section class="card hub-member-address" data-section="hub-member-address">
    <details class="s-ui-disclosure" open=${step !== "show" || !!outcome || !!error}><summary>${copy("title")}</summary><div class="s-ui-disclosure-body">${body}</div></details></section>`;
  if (view === undefined) return wrap(html`${head}<${Skeleton} variant="rows" lines=${3} />`);
  if (view.failed) return wrap(html`${head}<p class="err" role="alert">${copy("err_unavailable")}</p>`);

  const origin = typedOrigin(typed);
  const listen = touched ? { host: host.trim(), port: Number(port) } : defaultListen(view, origin || view.origin);
  const touch = () => { if (!touched) { setTouched(true); setHost(listen.host); setPort(String(listen.port)); } };
  const edit = () => { setStep("edit"); setTyped(""); setTouched(false); setError(""); setOutcome(null); };
  const check = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    if (!origin || !Number.isInteger(listen.port) || listen.port < 1 || listen.port > 65535 || !listen.host) { setError(copy("err_invalid")); return; }
    if (origin === view.origin && listen.host === view.listen?.host && listen.port === view.listen?.port) { setError(copy("err_unchanged")); return; }
    setBusy(true); setError("");
    const r = await client.prepare({ origin, listen });
    setBusy(false);
    if (!r.ok) { setError(copy(errKey(r.code))); return; }
    setProposal(r); setStep("confirm");
  };
  const confirm = async () => {
    if (busy || !proposal) return;
    setBusy(true); setError("");
    const r = await client.commit(proposal.ref);
    setBusy(false);
    if (!r.ok) { setError(copy(errKey(r.code))); if (r.code === "expired" || r.code === "stale") { setProposal(null); setStep("edit"); } return; }
    setOutcome(r); setStep("show");
    // Connected now: only the Fleets that followed (the rest were disconnected and must reconnect).
    const gone = new Set((Array.isArray(r.reconnect) ? r.reconnect : []).map((f) => f.id));
    setView((v) => ({ ...v, origin: r.origin || proposal.summary?.to, listen: proposal.summary?.listen || v.listen,
      fleets: (Array.isArray(v.fleets) ? v.fleets : []).filter((f) => !gone.has(f.id)) }));
    setProposal(null);
  };
  const fleetCount = Array.isArray(view.fleets) ? view.fleets.length : 0;
  const current = html`<dl class="s-web-ro hub-addr-now">
    <dt>${copy("address")}</dt><dd><code>${shownAddress(view.origin)}</code></dd>
    ${view.listen ? html`<dt>${copy("listens")}</dt><dd><code>${view.listen.host}:${view.listen.port}</code></dd>` : null}
    <dt>${copy("fleets")}</dt><dd>${fleetCount ? String(fleetCount) : copy("none")}</dd>
  </dl>`;
  const err = error ? html`<p class="err" role="alert">${error}</p>` : null;

  if (step === "confirm" && proposal) {
    const s = proposal.summary || {}, moving = Array.isArray(s.fleets) ? s.fleets : [], same = s.fleetsRejoin === false;
    return wrap(html`${head}<div class="hub-addr-confirm" role="group" aria-label=${copy("confirmTitle")}><h4>${copy("confirmTitle")}</h4>
        <dl class="s-web-ro">
          <dt>${copy("from")}</dt><dd>${shownAddress(s.from)}</dd>
          <dt>${copy("to")}</dt><dd><strong>${shownAddress(s.to)}</strong></dd>
          ${s.listen ? html`<dt>${copy("listens")}</dt><dd><code>${s.listen.host}:${s.listen.port}</code></dd>` : null}
        </dl>
        ${moving.length ? html`<p class="note hub-member-moving"><strong>${copy(same ? "connected" : "moving", String(moving.length))}</strong> ${moving.map((f, i) => html`<span key=${f.id} class="hub-member-fleet">${i ? copy("sep") : ""}${f.label || copy("unnamed")}</span>`)}</p>`
          : html`<p class="note">${copy("noneMoving")}</p>`}
        <p class="note hub-addr-effect">${copy(same ? "sameEffect" : "effect")}</p>
        <div class="s-row">
          <button type="button" class="btn btn-primary" disabled=${busy} onClick=${confirm}>${busy ? copy("saving") : copy("confirm")}</button>
          <button type="button" class="btn" disabled=${busy} onClick=${() => { setProposal(null); setStep("edit"); setError(""); }}>${copy("back")}</button>
        </div>
      </div>${err}`);
  }
  if (step === "edit") {
    return wrap(html`${head}${current}
      <form class="form hub-addr-form" onSubmit=${check}>
        <label class="field"><span>${copy("newAddress")}</span><input id="hubMemberNew" autocomplete="off" inputmode="url" value=${typed} disabled=${busy}
          onInput=${(e) => { setTyped(e.target.value); setError(""); }} /><small class="note">${copy("newHint")}</small></label>
        <details class="s-ui-disclosure hub-addr-advanced"><summary>${copy("advanced")}</summary><div class="s-ui-disclosure-body">
          <div class="grid2">
            <label class="field"><span>${copy("listenHost")}</span><input id="hubMemberHost" autocomplete="off" value=${listen.host} disabled=${busy} onInput=${(e) => { touch(); setHost(e.target.value); setError(""); }} /></label>
            <label class="field"><span>${copy("listenPort")}</span><input id="hubMemberPort" type="number" inputmode="numeric" min="1" max="65535" step="1" value=${String(listen.port)} disabled=${busy}
              onInput=${(e) => { touch(); setPort(e.target.value); setError(""); }} /></label>
          </div>
          <small class="note">${copy("listenHint")}</small>
        </div></details>
        <div class="s-row">
          <button type="submit" class="btn btn-primary" disabled=${busy || !typed.trim()}>${busy ? copy("checking") : copy("check")}</button>
          <button type="button" class="btn" disabled=${busy} onClick=${() => { setStep("show"); setError(""); }}>${copy("cancel")}</button>
        </div>
      </form>${err}`);
  }
  const done = outcome ? html`<p role="status" class=${outcome.state === "saved_unavailable" ? "err" : "note"}>${outcomeText(outcome, view.listen?.port)}</p>` : null;
  return wrap(html`${head}${current}${done}
    <div class="s-row"><button type="button" class="btn" id="hubMemberChange" onClick=${edit}>${copy("change")}</button></div>${err}`);
}
