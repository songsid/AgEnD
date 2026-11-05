// Shared presentation for Settings. Tab panels stay mounted so switching views never drops a form's draft.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";

register("settingsLayout", {
  en: {
    account: "Your account", personal: "Your preferences", fleet: "Whole fleet",
    lead_preferences: "Your identity, language and content preferences.",
    lead_look: "Choose how AgEnD looks and keep your workspace comfortable.",
    lead_agents: "Manage agents across runtimes, with their CLI, model and status in one place.",
    "lead_agent-defaults": "Changes here apply to every agent that has no setting of its own — including agents you create later.",
    lead_chat: "Connect chat services and choose how messages are received and delivered.",
    "lead_web-dashboard": "Manage fleet-wide dashboard features, branding and resource limits.",
    lead_access: "Manage sign-in, web authority, guests and sharing.",
    lead_advanced: "Inspect and edit fleet configuration, with effective values kept separate.",
    editor: "Configuration editor", effective: "Effective settings (read only)",
    aiAccounts: "AI accounts and keys", aiAccountsHint: "Sign-ins and supported provider keys on the AgEnD host. Windows CLI status is shown under Runtime.",
    classicDefaults: "ClassicBot defaults and access",
  },
  "zh-TW": {
    account: "你的帳號", personal: "你的偏好", fleet: "整個 Fleet",
    lead_preferences: "你的身分、語言與內容偏好。",
    lead_look: "調整顯示方式，保留你的工作習慣。",
    lead_agents: "集中管理各個 Runtime 的 Agent、CLI、模型與狀態。",
    "lead_agent-defaults": "改了會套用到所有沒有自己設定的 Agent，包括之後新建立的。",
    lead_chat: "連接聊天服務，設定訊息如何進入與送出。",
    "lead_web-dashboard": "管理整個 Fleet 的網頁功能、品牌與資源限制。",
    lead_access: "管理登入、網頁授權、訪客與對外分享。",
    lead_advanced: "檢視與編輯 Fleet 設定，並區分目前生效的唯讀內容。",
    editor: "設定編輯器", effective: "生效設定（唯讀）",
    aiAccounts: "AI 帳號與金鑰", aiAccountsHint: "管理 AgEnD 主機的登入與支援的供應商金鑰；Windows CLI 狀態請到 Runtime 查看。",
    classicDefaults: "ClassicBot 預設行為與存取",
  },
});

register("settingsLayout", {
  en: {
    aiAccounts: "AI sign-ins and API keys", aiAccountsSummary: "Host CLI sign-ins and provider API keys, managed separately.",
    aiHostScope: "Credentials on the AgEnD host", aiAccountsHint: "These sign-ins and keys belong to the host running AgEnD.", aiWindowsLink: "Manage Windows computers and their CLIs in Runtime",
    apiKeysTitle: "Provider API keys", apiKeysHint: "API credentials for supported provider integrations.", apiKeysUnavailableState: "Not offered", apiKeysUnavailable: "Provider API key management is not offered in this session.",
    apiNewPlaceholder: "Enter an API key to verify", apiReplacePlaceholder: "Enter a replacement API key",
  },
  "zh-TW": {
    aiAccounts: "AI 登入與 API 金鑰", aiAccountsSummary: "分開管理主機 CLI 登入與供應商 API 金鑰。",
    aiHostScope: "AgEnD 主機上的憑證", aiAccountsHint: "這裡的登入與金鑰屬於執行 AgEnD 的主機。", aiWindowsLink: "前往 Runtime 管理 Windows 電腦與 CLI",
    apiKeysTitle: "供應商 API 金鑰", apiKeysHint: "供支援的供應商整合功能使用的 API 憑證。", apiKeysUnavailableState: "目前未提供", apiKeysUnavailable: "此工作階段未提供供應商 API 金鑰管理。",
    apiNewPlaceholder: "輸入要驗證的 API 金鑰", apiReplacePlaceholder: "輸入替換用的 API 金鑰",
  },
});

export const layoutText = (key, ...values) => t(`settingsLayout.${key}`, ...values);

register("settingsLayout", {
  "en": {
    "accessLogin": "Sign-in & authority",
    "accessGuests": "Guests",
    "accessSharing": "Public & sharing",
    "accessSharingList": "Shared links",
    "accessPublicCredentials": "Cloudflare connector credentials",
    "accessPolicyHint": "How access changes take effect",
    "dashboardFeatures": "Features",
    "developerReadOnly": "Read-only mode",
    "developerEditing": "Editing draft",
    "effectiveKey": "Setting key",
    "effectiveValue": "Value in effect",
    "effectiveSource": "Source",
    "effectiveSourceConfig": "fleet.yaml",
    "effectiveSourceDefault": "Default"
  },
  "zh-TW": {
    "accessLogin": "登入與授權",
    "accessGuests": "訪客",
    "accessSharing": "公開與分享",
    "accessSharingList": "分享連結",
    "accessPublicCredentials": "Cloudflare 連接器憑證",
    "accessPolicyHint": "存取變更如何生效",
    "dashboardFeatures": "功能",
    "developerReadOnly": "唯讀模式",
    "developerEditing": "編輯草稿中",
    "effectiveKey": "設定鍵",
    "effectiveValue": "目前生效值",
    "effectiveSource": "來源",
    "effectiveSourceConfig": "fleet.yaml",
    "effectiveSourceDefault": "預設"
  }
});

export function SettingsPageHead({ section, children }) {
  const scope = section === "preferences" ? "account" : section === "look" ? "personal" : "fleet";
  return html`<header class="s-page-head"><div><div class="s-page-title"><h2>${t(`settings.sec_${section}`)}</h2><span class="s-scope">${layoutText(scope)}</span></div><p class="s-page-lead">${layoutText(`lead_${section}`)}</p></div>${children ? html`<div class="s-page-actions">${children}</div>` : null}</header>`;
}

// Settings search, validation links and legacy anchors reveal their owning tab before focusing a control.
const revealers = new Set();
export function useSettingsTabs(group, initial) {
  const [value, setValue] = useState(initial);
  const current = useRef(value);
  current.current = value;
  useEffect(() => {
    const reveal = target => {
      const panel = target?.closest?.("[data-settings-tabs]");
      if (!panel || panel.getAttribute("data-settings-tabs") !== group) return false;
      const next = panel.getAttribute("data-settings-tab");
      if (!next || next === current.current) return false;
      current.current = next;
      setValue(next);
      return true;
    };
    revealers.add(reveal);
    return () => revealers.delete(reveal);
  }, [group]);
  return [value, setValue];
}

export function revealSettingsTarget(target) {
  let changed = false;
  for (const reveal of revealers) changed = reveal(target) || changed;
  return changed;
}

export function SettingsTabs({ id, value, onChange, items }) {
  const choose = (key, focus = false) => {
    onChange(key);
    if (focus) document.getElementById(`${id}-tab-${key}`)?.focus();
  };
  const keydown = (event, index) => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    choose(items[next].id, true);
  };
  return html`<div class="s-page-tabs" role="tablist" aria-label=${t("settings.title")}>${items.map((item, index) => html`<button key=${item.id} id=${`${id}-tab-${item.id}`} type="button" role="tab" class=${value === item.id ? "on" : ""} aria-selected=${value === item.id ? "true" : "false"} aria-controls=${`${id}-panel-${item.id}`} tabindex=${value === item.id ? 0 : -1} onClick=${() => choose(item.id)} onKeyDown=${event => keydown(event, index)}>${item.label}</button>`)}</div>`;
}

export function SettingsTabPanel({ group, id, active, children }) {
  return html`<div id=${`${group}-panel-${id}`} class="s-tab-panel" role="tabpanel" aria-labelledby=${`${group}-tab-${id}`} data-settings-tabs=${group} data-settings-tab=${id} hidden=${!active}>${children}</div>`;
}

register("settingsLayout", {
  "en": {
    "profileIdentityDetails": "How agents recognise you",
    "previewsPersonalHint": "Only affects your preview preference.",
    "chatConnections": "Chat connections",
    "messageBehavior": "Message behavior",
    "pageContents": "On this page"
  },
  "zh-TW": {
    "profileIdentityDetails": "Agent 如何辨識你的身分",
    "previewsPersonalHint": "只影響你的預覽偏好。",
    "chatConnections": "聊天連線",
    "messageBehavior": "訊息行為",
    "pageContents": "本頁內容"
  }
});

register("settingsLayout", {
  "en": {
    "revDashboard_log": "Agent log tab",
    "revDashboardHint_log": "Show prompts, replies, tool steps and fleet events. Secrets are masked; public links can also see it. Enabling needs confirmation.",
    "revDashboard_usagePub": "Usage over the public link",
    "revDashboardHint_usagePub": "Offer the fleet usage report over the temporary public link. Guests never see it.",
    "revDashboard_levels": "Office levels",
    "revDashboardHint_levels": "Show each agent's lifetime work level on its Office name tag and profile.",
    "revDashboard_cdn": "CDN libraries in HTML previews",
    "revDashboardHint_cdn": "Allow cdnjs and jsDelivr. Requests leave this computer, are visible to the CDN and could send page data out.",
    "revDetails": "Details",
    "revAccessPolicy": "Loosening access needs fleet administrator confirmation. Tightening applies at once.",
    "revLoginSessions": "Sign-in sessions",
    "revPublicSessionLimit": "Public-link sessions are capped at 8 hours, end after 30 minutes idle and never outlive the link.",
    "revSessionDetails": "Session rules and notifications",
    "revRelatedAccess": "Other access settings",
    "revRelatedGuests": "Choose who can sign in and which agents they see.",
    "revRelatedSharing": "Manage the public entry and read-only shared links.",
    "revPublicEntry": "Fleet public entry",
    "revReadOnlySharing": "Time-limited read-only sharing",
    "revSharingOrigin": "Create new shares from the Office or an HTML preview. Manage existing links below.",
    "revEffectiveHint": "These are the values in effect. This view is read only; edit supported values in the configuration editor.",
    "revGoEditor": "Open configuration editor",
    "revEditorContext": "Fleet configuration · use the form pages for individual settings",
    "revUpdateCredential": "Update connector credential",
    "revSetCredential": "Set connector credential",
    "revAuthorityBrief": "Only signed-in fleet administrators can confirm their account's authority in Discord or Telegram. Guests cannot. Publishing, destructive actions, spending, secrets and passing authority require it.",
    "revAuthorityDetails": "Authority rules",
    "revAuthorityEnabled": "Allow web authority",
    "revAuthorityEnabledHint": "Turning this off invalidates existing authority at once. Turning it back on does not restore it.",
    "revAuthorityLocal": "Only this computer",
    "revAuthorityLocalHint": "Allow only this computer's browser. Authority already given over a LAN or tailnet becomes invalid and is not restored by switching this off.",
    "revAuthorityPublicWarning": "Public links are reached from the internet and Cloudflare sees their traffic. Enabling their authority needs confirmation; re-enabling temporary-link authority ends all earlier authorizations.",
    "revAuthorityLinks": "Authority over public links",
    "revGuestManagement": "Guest management",
    "revVisibleAgents": "Visible agents",
    "revGuestLevel": "Level",
    "revGuestDetail": "Selected guest",
    "revSelectGuest": "Add or choose a guest to manage their access."
  },
  "zh-TW": {
    "revDashboard_log": "Agent 紀錄分頁",
    "revDashboardHint_log": "顯示提示、回覆、工具步驟與 Fleet 事件；機密值會遮蔽，公開連結也看得到。開啟需確認。",
    "revDashboard_usagePub": "公開連結提供用量報告",
    "revDashboardHint_usagePub": "透過臨時公開連結提供 Fleet 用量報告；訪客一律看不到。",
    "revDashboard_levels": "辦公室等級",
    "revDashboardHint_levels": "在辦公室名牌與名片上顯示 Agent 依終身工作量得到的等級。",
    "revDashboard_cdn": "HTML 預覽載入 CDN 函式庫",
    "revDashboardHint_cdn": "允許 cdnjs 與 jsDelivr。請求會離開本機，CDN 能看到，也可能被頁面用來傳出資料。",
    "revDetails": "詳細說明",
    "revAccessPolicy": "放寬存取需要 Fleet 管理員確認；收緊的變更立即生效。",
    "revLoginSessions": "登入工作階段",
    "revPublicSessionLimit": "公開連結的工作階段最長 8 小時、閒置 30 分鐘登出，也不會超過連結期限。",
    "revSessionDetails": "工作階段與通知規則",
    "revRelatedAccess": "其他存取設定",
    "revRelatedGuests": "管理可登入的訪客與可見 Agent。",
    "revRelatedSharing": "管理公開入口與唯讀分享連結。",
    "revPublicEntry": "Fleet 公開入口",
    "revReadOnlySharing": "限時唯讀分享",
    "revSharingOrigin": "新分享請從辦公室或 HTML 預覽建立；在下方管理既有連結。",
    "revEffectiveHint": "下方為目前生效的設定，僅供檢視；需要修改時，請切換至設定編輯器。",
    "revGoEditor": "前往設定編輯器",
    "revEditorContext": "Fleet 設定檔・個別設定可使用對應表單調整",
    "revUpdateCredential": "更新連接器憑證",
    "revSetCredential": "設定連接器憑證",
    "revAuthorityBrief": "僅限已登入的 Fleet 管理者，並須在 Discord 或 Telegram 確認本人帳號授權；訪客不適用。發布、破壞性操作、花費、密鑰與轉交授權都需要它。",
    "revAuthorityDetails": "授權規則說明",
    "revAuthorityEnabled": "允許網頁授權",
    "revAuthorityEnabledHint": "關閉會立即使現有授權失效；重新開啟不會恢復。",
    "revAuthorityLocal": "僅限本機",
    "revAuthorityLocalHint": "只接受本機瀏覽器；區域網路與 tailnet 上已給出的授權會失效，關掉此限制也不會恢復。",
    "revAuthorityPublicWarning": "公開連結可從網際網路存取，Cloudflare 看得到流量。開啟其授權須經確認；重新開啟臨時連結授權會結束之前給出的全部授權。",
    "revAuthorityLinks": "公開連結的授權範圍",
    "revGuestManagement": "訪客管理",
    "revVisibleAgents": "可見 Agent",
    "revGuestLevel": "等級",
    "revGuestDetail": "選取的訪客",
    "revSelectGuest": "新增或選擇訪客後，管理其存取權限。"
  }
});
