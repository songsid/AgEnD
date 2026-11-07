// alpha.6 feedback (#2): Settings → Hub. Everything about this fleet and a Hub in one section, found by search: the
// membership switch, then (once it is on and the page is marked a member) Connect to a Hub — address and pairing code,
// the fingerprint to compare, the approval steps, then paired (open, disconnect) — with the agents shared there; and on
// a fleet that runs a Hub itself, its retention and browser-certificate cards. Each card stays its own lazy module, as
// it was under Access & security. Never over the public link: the member handlers are this computer's owner's only.
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";

register("settingsHubSection", {
  en: {
    publicLink: "Hub settings are only on this fleet's own dashboard, not over the public link.",
    relatedTitle: "Hub", relatedHint: "Connect this fleet to a team Hub and choose which agents to share.",
    groupsTitle: "Group permissions", groupsHint: "Let members of chosen directory groups chat with agents, share agents or connect their fleet. Set on the Hub, signed in as its administrator.",
    groupsOpen: "Open on the Hub", experimental: "Experimental",
  },
  "zh-TW": {
    publicLink: "Hub 設定只在這個 Fleet 自己的儀表板上提供，公開連結上沒有。",
    relatedTitle: "Hub", relatedHint: "將這個 Fleet 連線至團隊 Hub，並選擇要分享的 Agent。",
    groupsTitle: "群組權限", groupsHint: "讓指定目錄群組的成員與 Agent 對話、分享 Agent 或連接自己的 Fleet。在 Hub 上以管理員身分登入後設定。",
    groupsOpen: "在 Hub 上開啟", experimental: "實驗性",
  },
});
export const hubSectionText = (key) => t(`settingsHubSection.${key}`);

/** A card from its own lazy module (it loads only when this section is drawn). */
function Lazy({ load, pick }) {
  const [Card, setCard] = useState(null);
  useEffect(() => { let live = true; load().then((m) => { if (live) setCard(() => pick(m)); }, () => {}); return () => { live = false; }; }, []);
  return Card ? html`<${Card} />` : null;
}

/**
 * #3298 S-89: where the Hub's group permissions are set, found from this fleet's Settings. Only a link: the Hub's own sign-in and
 * its own capability marks decide what opens there (this page never reads a Hub session across origins). The address is this
 * fleet's own configured Hub web origin, accepted only as a bare HTTPS origin.
 */
export function hubGroupsHref(webOrigin) {
  try { const u = new URL(String(webOrigin || "")); return u.protocol === "https:" && u.origin === String(webOrigin).replace(/\/$/, "") ? `${u.origin}/ui/hub/admin?view=groups` : null; } catch { return null; }
}
function GroupPermissionsRow({ href }) {
  return html`<section class="card s-group" id="hub-group-permissions"><h3>${hubSectionText("groupsTitle")} <span class="tag warn">${hubSectionText("experimental")}</span></h3>
    <p class="note">${hubSectionText("groupsHint")}</p>
    <div class="s-row"><a class="btn btn-sm" href=${href} target="_blank" rel="noopener noreferrer">${hubSectionText("groupsOpen")}</a></div></section>`;
}

export function HubSection({ overPublicLink, hubHost, hubOrigin }) {
  const groupsHref = hubHost ? hubGroupsHref(hubOrigin) : null;
  if (overPublicLink) return html`<section class="card s-group" id="hub-public-link"><p class="note">${hubSectionText("publicLink")}</p></section>`;
  return html`<div class="s-hub-section">
    <${Lazy} load=${() => import("./settings-hub-membership.js")} pick=${(m) => m.HubMembershipSettings} />
    ${hubHost ? html`<${Lazy} load=${() => import("./settings-hub-retention.js")} pick=${(m) => m.HubRetentionSettings} />
      <${Lazy} load=${() => import("./settings-hub-browser-certificate.js")} pick=${(m) => m.HubBrowserCertificateSettings} />` : null}
    ${groupsHref ? html`<${GroupPermissionsRow} href=${groupsHref} />` : null}
  </div>`;
}
