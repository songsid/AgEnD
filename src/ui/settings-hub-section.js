// Fleet Settings → Hub: one connection card reuses the company handoff, manual pairing and Agent-sharing controls.
// Host setup and host-only settings keep their existing lazy modules and authority gates.
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";

register("settingsHubSection", {
  en: {
    publicLink: "Hub settings are only on this fleet's own dashboard, not over the public link.",
    relatedTitle: "Hub", relatedHint: "Connect this fleet to a team Hub and choose which agents to share.",
    groupsTitle: "Group permissions", groupsHint: "Let members of chosen directory groups chat with agents, share agents or connect their fleet. Set on the Hub, signed in as its administrator.",
    groupsOpen: "Open on the Hub", experimental: "Experimental", setupLink: "Set up a Hub",
  },
  "zh-TW": {
    publicLink: "Hub 設定只在這個 Fleet 自己的儀表板上提供，公開連結上沒有。",
    relatedTitle: "Hub", relatedHint: "將這個 Fleet 連接到團隊 Hub，並選擇要分享的 Agent。",
    groupsTitle: "群組權限", groupsHint: "讓指定目錄群組的成員與 Agent 對話、分享 Agent 或連接自己的 Fleet。在 Hub 上以管理員身分登入後設定。",
    groupsOpen: "在 Hub 上開啟", experimental: "實驗性", setupLink: "設定 Hub",
  },
});
export const hubSectionText = (key) => t(`settingsHubSection.${key}`);

/** A card from its own lazy module (it loads only when this section is drawn). */
function Lazy({ load, pick, props = {} }) {
  const [Card, setCard] = useState(null);
  useEffect(() => { let live = true; load().then((m) => { if (live) setCard(() => pick(m)); }, () => {}); return () => { live = false; }; }, []);
  return Card ? html`<${Card} ...${props} />` : null;
}

/**
 * #3298 S-89: where the Hub's group permissions are set, found from this fleet's Settings. Only a link: the Hub's own sign-in and
 * its own capability marks decide what opens there (this page never reads a Hub session across origins). The address is this
 * fleet's own configured Hub web origin, accepted only as a bare HTTPS origin.
 */
export function hubGroupsHref(webOrigin) {
  try { const u = new URL(String(webOrigin || "")); return u.protocol === "https:" && u.origin === String(webOrigin).replace(/\/$/, "") ? `${u.origin}/ui/hub/admin?view=groups` : null; } catch { return null; }
}
/** The page mark the fleet's server sets when its own Hub has group permissions composed (#3372 N2). */
export function hubGroupsMarked(doc = typeof document !== "undefined" ? document : null) {
  try { return !!doc && !!doc.body && doc.body.dataset.hubGroups === "1"; } catch { return false; }
}
function GroupPermissionsRow({ href }) {
  return html`<section class="card s-group" id="hub-group-permissions"><h3>${hubSectionText("groupsTitle")} <span class="tag warn">${hubSectionText("experimental")}</span></h3>
    <p class="note">${hubSectionText("groupsHint")}</p>
    <div class="s-row"><a class="btn btn-sm" href=${href} target="_blank" rel="noopener noreferrer">${hubSectionText("groupsOpen")}</a></div></section>`;
}

export function HubSection({ overPublicLink, hubHost, hubOrigin }) {
  // Only when this fleet's own Hub offers group permissions (the server's page mark), the same gate as the Hub's editor.
  const groupsHref = hubHost && hubGroupsMarked() ? hubGroupsHref(hubOrigin) : null;
  // M-2921 (spec 1.1): 「設定 Hub」 sits below the connection card, and folds to one line once this Fleet has a connection.
  const [joined, setJoined] = useState(false);
  if (overPublicLink) return html`<section class="card s-group" id="hub-public-link"><p class="note">${hubSectionText("publicLink")}</p></section>`;
  return html`<div class="s-hub-section">
    <${Lazy} load=${() => import("./settings-hub-connection.js").catch(() => import("./settings-hub-membership.js"))} pick=${m => m.HubConnectionSettings || m.HubMembershipSettings}
      props=${{ onMode: mode => { if (mode !== "unknown") setJoined(mode === "connected" || mode === "connecting" || mode === "paused"); } }} />
    ${!hubHost && typeof document !== "undefined" && document.body?.dataset.hubSetup === "1"
      ? joined ? html`<details class="s-ui-disclosure hub-setup-folded"><summary>${hubSectionText("setupLink")}</summary><${Lazy} load=${() => import("./settings-hub-setup.js")} pick=${(m) => m.HubSetupSettings} /></details>`
        : html`<${Lazy} load=${() => import("./settings-hub-setup.js")} pick=${(m) => m.HubSetupSettings} />` : null}
    ${hubHost && typeof document !== "undefined" && document.body?.dataset.hubDirectorySettings === "1"
      ? html`<${Lazy} load=${() => import("./settings-hub-directory.js")} pick=${m => m.HubDirectorySettings} />` : null}
    ${hubHost ? html`<${Lazy} load=${() => import("./settings-hub-run.js")} pick=${(m) => m.HubRunSettings} />
      <${Lazy} load=${() => import("./settings-hub-retention.js")} pick=${(m) => m.HubRetentionSettings} />
      <${Lazy} load=${() => import("./settings-hub-browser-certificate.js")} pick=${(m) => m.HubBrowserCertificateSettings} />
      <${Lazy} load=${() => import("./settings-hub-preview.js")} pick=${(m) => m.HubPreviewSettings} />` : null}
    ${groupsHref ? html`<${GroupPermissionsRow} href=${groupsHref} />` : null}
  </div>`;
}
