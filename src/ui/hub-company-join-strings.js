import { register, t } from "/assets/app-i18n.js";
export const companyAdminStringsV1 = true;
register("companyJoin", {
  en: {
    title: "Connect to a Hub", lead: "Use your company account. A successful connection enables membership; no Agents are shared.",
    address: "Hub address or company link", addressHint: "Use the company link from your Hub administrator, or the Hub's web address.",
    fleetName: "Fleet name", defaultFleet: "My Fleet", start: "Sign in with company account", pending: "Waiting for local confirmation…", loading: "Reading connection status…",
    joining: "Connecting your Fleet…", awaiting: "Finish signing in on the Hub page.", saved: "Fleet connected", offline: "Connection saved. Waiting for the Hub link…",
    stop: "Cancel connection", resume: "Recover this connection", retry: "Check again", held: "Connection needs attention", cancelled: "Connection cancelled",
    unknown: "The result could not be verified. Check this same connection before starting another one.",
    expired: "This connection request expired. If a Fleet was already created, inspect or revoke that exact Fleet on the Hub before starting again.",
    denied: "Your company account does not have permission to connect this Fleet. Ask your Hub administrator.",
    authority: "Local authorization changed. This connection stopped. Inspect its result on the Hub before trying again.",
    confirmationRequired: "Choose Recover this connection to request fresh local authorization for this same saved operation.",
    limit: "Your Fleet limit is reached. Disconnect an existing Fleet or ask your Hub administrator.",
    busy: "The Hub is busy. Check this same connection again shortly.",
    changed: "The Hub's identity is different. Connection stopped. Ask your Hub administrator for the new company link.",
    separateHosts: "The Hub and this Fleet need different web hostnames to keep their sign-ins separate. Ask your administrator for a different address; changing only the port is not enough.",
    repair: "Replace saved Hub identity", repairLead: "Paste a new company link you trust first. Replacing the saved identity needs a separate local authorization and does not connect a Fleet.",
    incompatible: "This Hub does not offer company sign-in joining. Use a pairing code under Other ways, or ask its administrator to enable company joining.",
    unsaved: "The connection could not be saved completely. Recover this same connection; do not create another one.",
    inspect: "Open Hub", issued: "A Fleet was created on the Hub. Its saved result is retained for inspection or revoke.",
    signInConnect: "Sign in and connect Fleet", connectAs: "Connect as {0}", request: "Connect {0}", origin: "Fleet address", return: "Return to Fleet Settings",
    approved: "Company sign-in accepted. Your Fleet is completing the connection…", done: "Your Fleet has connected. Return to its Settings to share Agents when you choose.",
    fleetDone: "Your Fleet is connected. You can now choose which Agents to share below.",
    inviteTitle: "Invitation exceptions", inviteLead: "For an eligible person without group permission. Issuing this invitation is your approval; it is bound to that person and this Hub.", inviteLogin: "Company sign-in name", inviteCreate: "Create invitation", inviteCopy: "Copy invitation",
    manualApproved: "Approved by your Hub administrator.", adminTitle: "Company sign-in joining", adminLead: "People allowed by Group permissions can connect their own Fleets. No approval is needed for each Fleet.",
    enabled: "Allow company-account Fleet connections", companyLink: "Company link", copy: "Copy company link", copied: "Copied", copyFailed: "Copy failed. Select and copy the link.",
    accessTitle: "Allowed groups and people", accessLead: "Choose allowed AD groups, or invite an eligible person as an individual Fleet-connection exception.", groupOpen: "Manage group permissions", colleagueCopy: "Copy link with key fingerprint", colleagueHint: "This link carries the Hub address and its pinned identity. Colleagues paste it into their Fleet’s Settings → Hub.", linkDetails: "Connection link contents", offHint: "Turn on company-account Fleet connections before copying a connection link or creating an invitation.", inviteScope: "This invitation approves one Fleet connection. It does not grant permission to chat with or share Agents.",
    firstUse: "On first use, this Fleet saves the Hub's identity. Use a company link you received from your administrator.",
    linkLead: "Open your Fleet's Settings → Hub and paste this company link. If you know its web address, open those Settings below. This page does not connect a Fleet or ask for your company password.",
    fleetAddress: "Fleet web address", openFleet: "Open Fleet Settings", invalidLink: "This company link is incomplete. Ask your Hub administrator for a new link.",
    failed: "The Hub could not verify this connection. Return to Fleet Settings and check the same request.",
  },
  "zh-TW": {
    title: "連接 Hub", lead: "使用公司帳號登入，連接成功後會啟用成員功能，不會分享任何 Agent。",
    address: "Hub 位址或公司連結", addressHint: "貼上 Hub 管理員提供的公司連結，或輸入 Hub 網址。",
    fleetName: "Fleet 名稱", defaultFleet: "我的 Fleet", start: "以公司帳號登入", pending: "等待本機授權確認…", loading: "正在讀取連接狀態…",
    joining: "正在連接 Fleet…", awaiting: "請在 Hub 頁面完成公司帳號登入。", saved: "Fleet 已連接", offline: "連接資料已儲存，正在等待與 Hub 的網路連線…",
    stop: "取消連接", resume: "恢復這次連接", retry: "再次檢查", held: "連接需要處理", cancelled: "已取消連接",
    unknown: "目前無法確認結果。請先檢查這次連接，不要另開一次連接。",
    expired: "這次連接請求已過期。若 Hub 已建立 Fleet，請先到 Hub 檢查或撤銷該 Fleet，再重新連接。",
    denied: "你的公司帳號沒有連接這個 Fleet 的權限，請洽 Hub 管理員。",
    authority: "本機授權已變更，這次連接已停止。請先到 Hub 檢查結果，再重新操作。",
    confirmationRequired: "請選擇「恢復這次連接」，為同一個已儲存的操作重新取得本機授權。",
    limit: "你的 Fleet 數量已達上限。請先中斷既有 Fleet，或洽 Hub 管理員。",
    busy: "Hub 目前忙碌，請稍後再次檢查這次連接。",
    changed: "Hub 的身分與先前不同，已停止連接。請向 Hub 管理員取得新的公司連結。",
    separateHosts: "Hub 與這個 Fleet 必須使用不同的網頁主機名稱，才能分開登入。請向管理員取得不同的位址；只更換連接埠仍不安全。",
    repair: "更換已儲存的 Hub 身分", repairLead: "請先貼上你信任的新公司連結。更換已儲存的身分需另行取得本機授權，不會連接 Fleet。",
    incompatible: "這個 Hub 尚未提供公司帳號連接。請改用「其他方式」裡的配對碼，或洽管理員啟用公司帳號連接。",
    unsaved: "連接資料尚未完整儲存。請恢復這次連接，不要另開一次連接。",
    inspect: "開啟 Hub", issued: "Hub 已建立 Fleet，會保留這次結果供你檢查或撤銷。",
    signInConnect: "登入並連接 Fleet", connectAs: "以 {0} 的身分連接", request: "連接 {0}", origin: "Fleet 位址", return: "返回 Fleet 設定",
    approved: "公司帳號已確認，Fleet 正在完成連接…", done: "Fleet 已連接。返回 Fleet 設定後，可自行選擇要分享的 Agent。",
    fleetDone: "Fleet 已連接，你可以在下方選擇要分享的 Agent。",
    inviteTitle: "例外邀請", inviteLead: "提供給尚無群組權限的合格人員。發出邀請即代表你的核准，邀請只限該人員與這個 Hub 使用。", inviteLogin: "公司登入名稱", inviteCreate: "建立邀請", inviteCopy: "複製邀請",
    manualApproved: "由 Hub 管理員核准。", adminTitle: "公司帳號連接", adminLead: "群組權限允許的人員可連接自己的 Fleet，不需逐一核准。",
    enabled: "允許以公司帳號連接 Fleet", companyLink: "公司連結", copy: "複製公司連結", copied: "已複製", copyFailed: "複製失敗，請選取並複製連結。",
    accessTitle: "允許的群組與人員", accessLead: "設定允許的 AD 群組，或為合格人員發出個別 Fleet 連接例外邀請。", groupOpen: "管理群組權限", colleagueCopy: "複製含金鑰指紋的連結", colleagueHint: "連結包含 Hub 位址與固定的身分指紋；請同仁貼到自己 Fleet 的「設定 → Hub」。", linkDetails: "連接連結內容", offHint: "請先開啟公司帳號連接，才能複製連結或建立邀請。", inviteScope: "邀請只核准一次 Fleet 連接，不會授予 Agent 對話或分享權限。",
    firstUse: "首次連接時，這個 Fleet 會記住 Hub 的身分。請使用管理員提供的公司連結。",
    linkLead: "請開啟你的 Fleet「設定 → Hub」，貼上這個公司連結。若知道 Fleet 網頁位址，也可在下方開啟設定。這個頁面不會連接 Fleet，也不會要求公司密碼。",
    fleetAddress: "Fleet 網頁位址", openFleet: "開啟 Fleet 設定", invalidLink: "這個公司連結不完整，請向 Hub 管理員取得新連結。",
    failed: "Hub 無法確認這次連接。請返回 Fleet 設定，檢查同一個請求。",
  },
});
export const hj = (key, ...args) => t(`companyJoin.${key}`, ...args);
/** A held Settings replay carries the handler's code in its bounded structured outcome, not its translated message. */
export function joinResponseCode(result) {
  const detail = result?.confirmed?.outcome?.detail, match = typeof detail === "string" && /^apply_rejected: ([a-z-]{1,64})$/.exec(detail);
  return match ? match[1] : result?.body?.error;
}
export function joinError(code) {
  return hj(code === "separate-hostnames" ? "separateHosts" : code === "identity-changed" ? "changed" : code === "denied" ? "denied" : code === "limit-reached" ? "limit"
    : code === "authority" || code === "revoked" ? "authority" : code === "confirmation-required" ? "confirmationRequired" : code === "expired" ? "expired" : code === "incompatible" ? "incompatible"
    : code === "backpressure" ? "busy" : code === "cancelled" ? "cancelled" : code === "unsaved" ? "unsaved" : "unknown");
}
