// S-120 (M-2753 story 8): Settings → Access & security → Overview. Three cards up front — who is signed in (admins and
// guests, each with Sign out), the ways in from outside (the public link, a fixed address, connections from outside,
// shared links; Close now where the page may), and two-step confirmation (THIS admin's own authenticator, #3503: shown and
// linked, never changed here) — then the other connections, each on its own page with its own disconnect or remove.
// Every action here is an existing route asked again by the server: a sign-out is POST /ui/devices/signout (#3553).
// The words are English and 繁體中文, as everything in src/ui (tests/i18n-ui-literals-2390.test.ts).
import { html, useEffect, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Icon } from "/assets/ui-icons.js";
import { navigate } from "/assets/app-nav.js";
import { appStore, useStore } from "/assets/app-store.js";
import { sectionPath } from "/assets/app-route.js";
import { api } from "./settings-confirm.js";
import { agoWords } from "./settings-devices.js";
import { roleName } from "/assets/device-roles.js";

register("accessov", {
  en: {
    tab: "Overview", devicesTitle: "Signed-in devices", devicesCount: "{0} signed in", more: "{0} more in Devices & sign-in", manageDevices: "Devices & sign-in", manageGuests: "Guests",
    legend: "✓ the verified owner: may add devices and sign others out. Not verified: everyday use only.",
    blockedOwner: "Verify as the owner first to sign out other devices.", blockedOther: "Another admin's device: only that admin can sign it out.",
    signOutTitle: "Sign out {0}?", signOutLead: "{0} is signed out at once and has to sign in again.", signedOut: "{0} was signed out.",
    entryTitle: "Ways in from outside", publicLink: "Public link", publicLinkHint: "An address that opens this dashboard from anywhere; signing in is still required.",
    linkOpen: "Open", linkQuick: "temporary address", linkNamed: "fixed address {0}", linkLeft: "{0} left", hm: "{0} h {1} min", h: "{0} h", m: "{0} min", linkNoExpiry: "no expiry", linkClosed: "Closed", linkNotAllowed: "Not allowed",
    outside: "Connections from outside", outsideHint: "Signing in from outside with the 6-digit code (authenticator app).", allowed: "Allowed", off: "Off",
    shares: "Shared links", sharesHint: "Read-only office views and pages; whoever has the link can view them without signing in.",
    sharesCount: "{0} open", none: "None", closeNow: "Close the public link now", manageSharing: "Public & sharing",
    closeTitle: "Close the public link now?", closeLead: "The link stops working at once. Devices signed in through it are signed out.", closeGo: "Close the link", closed: "The public link is closed.", closeFailed: "The link could not be closed. Try again.",
    outsideOwned: "This is the outside connection. Turn off “Connections from outside” in Owner verification to close it.",
    twoStepTitle: "Owner verification", twoStepMine: "Your own authenticator app. Every admin sets up their own.",
    app: "Authenticator app", appSet: "Set up on {0}", appNone: "Not set up", askCode: "Ask for my 6-digit code to confirm changes",
    on: "On", goOwner: "Owner verification settings", twoStepNone: "Without it, changes from other devices are confirmed with Apply now.",
    otherTitle: "Other connections", otherLead: "Disconnect or remove each one on its own page.",
    hub: "Hub", hubHint: "Your team's Hub and the agents shared there", windows: "Windows computers", windowsHint: "Windows computers connected to run agents",
    accounts: "AI accounts", accountsHint: "The Claude, Codex and other accounts your agents use", hubOn: "Connected", paired: "{0} connected",
  },
  "zh-TW": {
    tab: "總覽", devicesTitle: "已登入的裝置", devicesCount: "{0} 個登入", more: "另外 {0} 個，到「裝置與登入」查看", manageDevices: "裝置與登入", manageGuests: "訪客",
    legend: "✓ 已驗證的擁有者：可新增裝置、登出其他裝置。未驗證：只能使用一般功能。",
    blockedOwner: "要先驗證為擁有者，才能登出其他裝置。", blockedOther: "別的管理員的裝置，只有那位管理員本人能登出。",
    signOutTitle: "登出 {0}？", signOutLead: "{0} 會立即登出，之後需要重新登入。", signedOut: "已登出 {0}。",
    entryTitle: "從外面連線的方式", publicLink: "公開連結", publicLinkHint: "從任何地方開啟這個儀表板的網址；開啟後仍要登入。",
    linkOpen: "開啟中", linkQuick: "臨時網址", linkNamed: "固定網址 {0}", linkLeft: "剩 {0}", hm: "{0} 小時 {1} 分", h: "{0} 小時", m: "{0} 分", linkNoExpiry: "不過期", linkClosed: "已關閉", linkNotAllowed: "不允許",
    outside: "從外面連線", outsideHint: "從外面登入時，用 6 位數驗證碼（驗證器 App）。", allowed: "允許", off: "關閉",
    shares: "分享連結", sharesHint: "唯讀的辦公室畫面或網頁；拿到連結的人不用登入就能看。",
    sharesCount: "{0} 個開放中", none: "沒有", closeNow: "立即關閉公開連結", manageSharing: "公開與分享",
    closeTitle: "立即關閉公開連結？", closeLead: "連結會馬上失效，透過它登入的裝置也會一併登出。", closeGo: "關閉連結", closed: "公開連結已關閉。", closeFailed: "沒能關閉連結，請再試一次。",
    outsideOwned: "這是「從外面連線」用的連結。要關閉，請到擁有者驗證關掉「從外面連線」。",
    twoStepTitle: "擁有者驗證", twoStepMine: "這是你自己的驗證器 App；每位管理員各自設定。",
    app: "驗證器 App", appSet: "已於 {0} 設定", appNone: "尚未設定", askCode: "確認變更時要求我的 6 位數驗證碼",
    on: "開啟", goOwner: "擁有者驗證設定", twoStepNone: "未設定時，其他裝置上的變更以「立即套用」確認。",
    otherTitle: "其他連線", otherLead: "到各自的頁面中斷或移除。",
    hub: "Hub", hubHint: "你的團隊 Hub，以及在那裡分享的 Agent", windows: "Windows 電腦", windowsHint: "連上這裡、用來執行 Agent 的 Windows 電腦",
    accounts: "AI 帳號", accountsHint: "Agent 使用的 Claude、Codex 等帳號", hubOn: "已連接", paired: "已連上 {0} 台",
  },
});
const to = (k, ...a) => t(`accessov.${k}`, ...a);
/** M-2855: the tab's own label (a tab opened before this page existed holds an older settings-layout.js without it). */
export const accessOverviewLabel = () => to("tab");

/**
 * M-2855: this page's stylesheet, linked once when the module loads (a tab opened before this page existed holds an
 * older app.css with none of its rules). Before first render, so the cards never paint unstyled.
 */
export function linkAccessOverviewCss(doc = typeof document !== "undefined" ? document : null) {
  try {
    if (!doc || !doc.head || doc.querySelector('link[data-access-overview-css="1"]')) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/access-overview.css"); link.setAttribute("data-access-overview-css", "1");
    doc.head.appendChild(link);
  } catch { /* the page still works without it */ }
}
linkAccessOverviewCss();
const SHOWN = 4;
const leftWords = (ms) => { const m = Math.max(1, Math.round(ms / 60_000)); return m >= 60 ? (m % 60 ? to("hm", Math.floor(m / 60), m % 60) : to("h", Math.floor(m / 60))) : to("m", m); };
const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`; };

function Row({ label, value, tone, hint }) {
  return html`<div class="s-ov-row"><dt>${label}</dt><dd class=${tone ? `s-ov-${tone}` : ""}>${value}</dd>${hint ? html`<small class="s-ov-hint">${hint}</small>` : null}</div>`;
}
function More({ label, onClick }) {
  return html`<button type="button" class="s-ov-link" onClick=${onClick}><span>${label}</span><${Icon} name="chevron" size=${14} /></button>`;
}

export function AccessOverview({ web = {}, hub, openTab, overPublicLink, active = true }) {
  // Devices: GET /ui/devices only (#3553) — every tier, its role, and whether this session may sign it out.
  const [devices, setDevices] = useState(null);
  const [outside, setOutside] = useState(null);
  const [shares, setShares] = useState(null), [machines, setMachines] = useState(null);
  const [ask, setAsk] = useState(null), [askClose, setAskClose] = useState(false), [linkNote, setLinkNote] = useState("");
  const { publicLink } = useStore(appStore);
  // #3600: the status frame this page saw when its close went through. Until the next frame arrives (each frame is a new
  // object), that frame still says "open" for a link that is already closed: it is shown as closed, at once.
  const [closedFrame, setClosedFrame] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const load = async () => {
    const [d, o] = await Promise.all([api("/ui/devices"), api("/ui/outside")]);
    if (d.ok && d.body) setDevices(d.body.devices || []);
    if (o.ok && o.body) setOutside(o.body);
    // Existing reads only: the share lists (office + page) and the paired computers; one that is refused says nothing.
    const [os, ps, rt] = await Promise.all([api("/ui/office-share"), api("/ui/page-share"), api("/ui/runtimes")]);
    setShares([os, ps].reduce((n, r) => n + (r.ok && r.body && Array.isArray(r.body.shares) ? r.body.shares.length : 0), 0));
    if (rt.ok && rt.body && rt.body.enabled) setMachines((rt.body.machines || []).length);
  };
  // Read again whenever the tab is shown: the tab panels stay mounted, so a device signed out on 裝置與登入 (or a link
  // closed elsewhere) would otherwise still be listed here.
  useEffect(() => { if (active) load(); }, [active]);
  const rows = [...(devices || [])].sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
  const blockedWhy = (d) => to(d.signOutBlocked === "other_admin" ? "blockedOther" : "blockedOwner");
  const signOut = async () => {
    const d = ask; setBusy(true);
    const r = await api("/ui/devices/signout", { method: "POST", body: JSON.stringify({ handle: d.handle }) });
    setBusy(false); setAsk(null); setNote(r.ok ? to("signedOut", d.label) : (r.body && r.body.error) || `HTTP ${r.status}`);
    load();
  };
  // The link's state: the shell's status frame (every fleet; a tab from before S-120 has none — then /ui/outside's).
  const pub = web.public_link || {};
  const framed = publicLink && publicLink.state !== "closed" && publicLink !== closedFrame ? { ...publicLink, quick: !pub.hostname } : null;
  const link = framed || (outside && outside.link) || null;
  // A web-only fleet's outside link is the owner's switch (#3008): closed there, not here (the route answers 409).
  const outsideOwned = !!(link && outside && outside.webOnly && outside.outside);
  const closeLink = async () => {
    setBusy(true);
    const seen = publicLink;
    const r = await api("/ui/public-link/close", { method: "POST", body: "{}" });
    setBusy(false); setAskClose(false);
    if (r.ok && r.body && r.body.closed === true) setClosedFrame(seen);   // only a close that happened; a refusal changes nothing
    setLinkNote(r.ok ? to("closed") : r.body && r.body.error === "outside_link" ? to("outsideOwned") : to("closeFailed"));
    load();
  };
  const linkValue = link ? html`<span class="tag tag-ok">${to("linkOpen")}</span> ${link.quick ? to("linkQuick") : to("linkNamed", pub.hostname || "")} · ${link.noExpiry ? to("linkNoExpiry") : link.expiresAt ? to("linkLeft", leftWords(link.expiresAt - Date.now())) : ""}`
    : pub.allow_public === false ? to("linkNotAllowed") : pub.hostname ? `${to("linkClosed")} · ${to("linkNamed", pub.hostname)}` : to("linkClosed");
  return html`<div class="s-ov" id="accessOverview">
    <div class="s-ov-grid">
      <section class="card s-ov-card s-ov-devices" id="ovDevices"><h3 class="s-ov-title"><${Icon} name="user" size=${18} />${to("devicesTitle")}</h3>
        <p class="note">${to("devicesCount", rows.length)}</p>
        <ul class="s-ov-devlist s-ov-list">${rows.slice(0, SHOWN).map((d) => html`<li class=${`s-ov-dev${d.current ? " current" : ""}`} key=${d.handle} data-handle=${d.handle}>
          <div class="s-ov-dev-main"><span class="s-ov-dev-name">${d.label}${d.current ? html` <span class="tag">${t("app.thisDevice")}</span>` : null}</span>
            <span class="s-ov-dev-meta"><span data-role=${d.tier === "admin" ? (d.verified ? "owner" : "admin") : d.tier}>${roleName(d.tier, d.verified)}</span> · ${t("app.lastActive", agoWords(d.lastSeen))}</span>
            ${!d.current && !d.canSignOut ? html`<span class="s-ov-why">${blockedWhy(d)}</span>` : null}</div>
          ${d.current ? null : html`<button type="button" class=${`btn btn-sm${d.canSignOut ? " btn-danger" : ""}`} data-ov-signout=${d.handle} disabled=${!d.canSignOut || busy} onClick=${() => d.canSignOut && setAsk(d)}>${t("app.signOut")}</button>`}
        </li>`)}</ul>
        ${rows.length > SHOWN ? html`<${More} label=${to("more", rows.length - SHOWN)} onClick=${() => openTab("login", "devicesCard")} />` : null}
        <p class="note s-ov-legend">${to("legend")}</p>
        ${note ? html`<p class="note" role="status">${note}</p>` : null}
        <footer><${More} label=${to("manageDevices")} onClick=${() => openTab("login", "devicesCard")} /><${More} label=${to("manageGuests")} onClick=${() => openTab("guests")} /></footer>
      </section>
      <section class="card s-ov-card" id="ovEntry"><h3 class="s-ov-title"><${Icon} name="globe" size=${18} />${to("entryTitle")}</h3>
        <dl class="s-ov-facts">
          <${Row} label=${to("publicLink")} hint=${to("publicLinkHint")} value=${linkValue} />
          ${outside && outside.webOnly ? html`<${Row} label=${to("outside")} hint=${to("outsideHint")} value=${to(outside.outside ? "allowed" : "off")} />` : null}
          ${shares !== null ? html`<${Row} label=${to("shares")} hint=${to("sharesHint")} value=${shares ? to("sharesCount", shares) : to("none")} tone=${shares ? "" : "muted"} />` : null}
        </dl>
        ${link && !overPublicLink ? outsideOwned
          ? html`<p class="note" id="ovOutsideOwned">${to("outsideOwned")} <${More} label=${to("goOwner")} onClick=${() => openTab("login", "outsideCard")} /></p>`
          : html`<div class="s-ov-actions"><button type="button" class="btn btn-sm btn-danger" id="ovCloseLink" disabled=${busy} onClick=${() => setAskClose(true)}>${to("closeNow")}</button></div>` : null}
        ${linkNote ? html`<p class="note" role="status" id="ovLinkNote">${linkNote}</p>` : null}
        <footer><${More} label=${to("manageSharing")} onClick=${() => openTab("sharing")} /></footer>
      </section>
      <section class="card s-ov-card" id="ovTwoStep"><h3 class="s-ov-title"><${Icon} name="key" size=${18} />${to("twoStepTitle")}</h3>
        <p class="note">${to("twoStepMine")}</p>
        <dl class="s-ov-facts">
          <${Row} label=${to("app")} value=${outside && outside.enrolled ? html`<span class="tag tag-ok">${to("appSet", day(outside.enrolledAt))}</span>` : html`<span class="tag">${to("appNone")}</span>`} />
          <${Row} label=${to("askCode")} value=${to(outside && outside.strict ? "on" : "off")} tone=${outside && outside.strict ? "" : "muted"} />
        </dl>
        ${outside && !outside.enrolled ? html`<p class="note">${to("twoStepNone")}</p>` : null}
        <footer><${More} label=${to("goOwner")} onClick=${() => openTab("login", "outsideCard")} /></footer>
      </section>
    </div>
    <section class="s-ov-other" id="ovOther"><h3>${to("otherTitle")}</h3><p class="note">${to("otherLead")}</p>
      <div class="s-ov-tiles">
        ${[["plug", "hub", "hubHint", "hub", hub ? to("hubOn") : null], ["code", "windows", "windowsHint", "runtimes", machines ? to("paired", machines) : null], ["bot", "accounts", "accountsHint", "agents", null]].map(([icon, k, hint, sec, state]) => html`
          <button type="button" class="s-ov-tile" data-ov-go=${sec} onClick=${() => navigate(sectionPath(sec))}><${Icon} name=${icon} size=${18} />
            <span><strong>${to(k)}</strong><small>${to(hint)}</small>${state ? html`<small class="s-ov-state">${state}</small>` : null}</span><${Icon} name="chevron" size=${16} /></button>`)}
      </div>
    </section>
    ${askClose ? html`<${Dialog} title=${to("closeTitle")} onClose=${() => { if (!busy) setAskClose(false); }} busy=${busy} actions=${html`
      <button type="button" class="btn" disabled=${busy} onClick=${() => setAskClose(false)}>${t("app.cancel")}</button>
      <button type="button" class="btn btn-danger" id="ovCloseGo" disabled=${busy} onClick=${closeLink}>${to("closeGo")}</button>`}>
      <p class="note">${to("closeLead")}</p></${Dialog}>` : null}
    ${ask ? html`<${Dialog} title=${to("signOutTitle", ask.label)} onClose=${() => { if (!busy) setAsk(null); }} busy=${busy} actions=${html`
      <button type="button" class="btn" disabled=${busy} onClick=${() => setAsk(null)}>${t("app.cancel")}</button>
      <button type="button" class="btn btn-danger" id="ovSignOutGo" disabled=${busy} onClick=${signOut}>${t("app.signOut")}</button>`}>
      <p class="note">${to("signOutLead", ask.label)}</p></${Dialog}>` : null}
  </div>`;
}
