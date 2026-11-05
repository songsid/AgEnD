// AgEnD Hub P1, slice 3 (docs/design/hub-ui-client.md): the Hub pages' own words, en and zh-TW, and their stylesheet.
// A lazy module of its own: loaded only with a Hub page or card, never while the Hub is off. It imports only names every
// shell has had since #1408 (register / t), so a tab opened before an upgrade loads it as fresh as the rest.
import { register, t } from "/assets/app-i18n.js";

register("hub", {
  en: {
    preview: "Preview: the Hub connection isn't available in this build yet, so nothing here leaves this page.",
    // The member's switcher
    myFleet: "My fleet", hub: "Hub", openHubTab: "Open {0} in a new tab", switcher: "Workspace",
    // The Hub's own pages
    askTitle: "Ask", askEmpty: "No agents you can ask yet", askHint: "When an owner shares an agent with you, it appears here with who allowed it.",
    exposuresTitle: "My exposures", exposuresEmpty: "You don't share any agents yet",
    exposuresHint: "Share an agent from your own fleet: Settings → Access & security → Connect to a Hub.",
    adminTitle: "Administration", adminEmpty: "Nothing to manage yet", adminHint: "Paired fleets, grants and the audit log appear here.",
    // Settings → Connect to a Hub
    title: "Connect to a Hub",
    lead: "A Hub lets people in your organisation ask agents you choose to share. Your fleet stays yours: you decide which agents are shared and who may ask them.",
    address: "Hub address", addressHint: "The https:// address your Hub administrator gave you.", code: "One-time pairing code", connect: "Connect",
    errAddress: "Enter the Hub's https:// address.", errCode: "Enter the pairing code exactly as it was given.",
    errBusy: "This fleet is already connected or waiting for approval.", errUnreachable: "Could not reach the Hub at that address.",
    errRefused: "The Hub refused this code.", errFailed: "That didn't work. Try again.",
    pendingTitle: "Waiting for approval", pairingFp: "Pairing fingerprint",
    pendingCompare: "Compare it with the fingerprint on the Hub's screen. Both must match before you confirm there.",
    pendingSteps: "Still needed:", ownerStep: "your confirmation, from your own Hub sign-in", adminStep: "the Hub administrator's approval",
    done: "done", waiting: "waiting", expires: "Expires {0}", cancel: "Cancel request", showFull: "Show the full fingerprint", hideFull: "Hide",
    pairedTitle: "Connected to {0}", online: "Online", offline: "Offline: reconnecting", hubKeyFp: "Hub key fingerprint",
    openHub: "Open the Hub", disconnect: "Disconnect",
    disconnectAsk: "Disconnect from {0}? Every agent you share there is withdrawn.",
    disconnectPending: "Disconnected here. The Hub hasn't confirmed it yet; it will be told when it can be reached.",
    keyTitle: "The Hub's key changed",
    keyLead: "Nothing connects until you pair again. If you didn't expect this, ask your Hub administrator before pairing again.",
    keyApproved: "Approved key", keyOffered: "Key the Hub presents now", repair: "Pair again",
    heldTitle: "On hold", holdClear: "Start over",
    hold_unknown_outcome: "The last pairing step's result is unknown. Nothing runs until it is checked.",
    hold_expired: "The pairing request expired.", hold_unsaved: "This fleet couldn't save its Hub settings. Nothing connects until they can be saved.",
    hold_refused: "The Hub refused the pairing.", hold_revoked: "The Hub revoked this fleet's pairing.", hold_other: "Pairing is on hold.",
    sharedTitle: "Shared agents",
    sharedLead: "Every agent is private unless you share it. Only an agent that can run in a restricted, read-only mode can be shared.",
    share: "Share {0}", notEnforceable: "Can't be shared yet: restricted mode isn't available for it.", frozen: "Frozen by the Hub",
    policy: "Shares {0} · tools: {1}", noAgents: "This fleet has no agents yet.",
    errConflict: "This list changed in another tab. It has been reloaded; try again.", errUnsaved: "Couldn't save this change.",
    errNotPaired: "Connect to a Hub first.", withdrawPending: "Withdrawn here. The Hub will be told when it can be reached.",
  },
  "zh-TW": {
    preview: "預覽：這個版本還不能真正連線到 Hub，這裡的操作不會離開這個頁面。",
    myFleet: "我的 Fleet", hub: "Hub", openHubTab: "在新分頁開啟 {0}", switcher: "工作區",
    askTitle: "提問", askEmpty: "目前還沒有你可以提問的 Agent", askHint: "有人把 Agent 開放給你之後，它會出現在這裡，並註明是誰授權的。",
    exposuresTitle: "我的公開 Agent", exposuresEmpty: "你還沒有公開任何 Agent",
    exposuresHint: "請在自己的 Fleet 公開 Agent：設定 → 存取與安全 → 連線到 Hub。",
    adminTitle: "管理", adminEmpty: "目前沒有要管理的項目", adminHint: "已配對的 Fleet、授權與稽核紀錄會出現在這裡。",
    title: "連線到 Hub",
    lead: "Hub 讓組織裡的人可以向你選擇公開的 Agent 提問。你的 Fleet 仍然屬於你：要公開哪些 Agent、誰可以提問，都由你決定。",
    address: "Hub 位址", addressHint: "Hub 管理者給你的 https:// 位址。", code: "一次性配對碼", connect: "連線",
    errAddress: "請輸入 Hub 的 https:// 位址。", errCode: "請完整輸入配對碼。",
    errBusy: "這個 Fleet 已經連線，或正在等待核准。", errUnreachable: "無法連到這個位址的 Hub。",
    errRefused: "Hub 拒絕了這個配對碼。", errFailed: "沒有成功，請再試一次。",
    pendingTitle: "等待核准", pairingFp: "配對指紋",
    pendingCompare: "請和 Hub 畫面上的指紋比對，兩者相同後再到 Hub 確認。",
    pendingSteps: "還需要：", ownerStep: "你用自己的 Hub 帳號確認", adminStep: "Hub 管理者核准",
    done: "已完成", waiting: "等待中", expires: "{0} 到期", cancel: "取消請求", showFull: "顯示完整指紋", hideFull: "收合",
    pairedTitle: "已連線到 {0}", online: "在線", offline: "離線，正在重新連線", hubKeyFp: "Hub 金鑰指紋",
    openHub: "開啟 Hub", disconnect: "中斷連線",
    disconnectAsk: "要中斷與 {0} 的連線嗎？你在那裡公開的 Agent 都會撤回。",
    disconnectPending: "已在這裡中斷。Hub 尚未確認，連得上時會再通知它。",
    keyTitle: "Hub 的金鑰已變更",
    keyLead: "重新配對前不會連線。若你沒有預期這個變更，請先詢問 Hub 管理者，再重新配對。",
    keyApproved: "已核准的金鑰", keyOffered: "Hub 目前提供的金鑰", repair: "重新配對",
    heldTitle: "暫停中", holdClear: "重新開始",
    hold_unknown_outcome: "最後一個配對步驟的結果不明，確認之前不會執行任何工作。",
    hold_expired: "配對請求已過期。", hold_unsaved: "這個 Fleet 無法儲存 Hub 設定，可以儲存之前不會連線。",
    hold_refused: "Hub 拒絕了這次配對。", hold_revoked: "Hub 已撤銷這個 Fleet 的配對。", hold_other: "配對已暫停。",
    sharedTitle: "公開的 Agent",
    sharedLead: "每個 Agent 預設都不公開。只有能在受限、唯讀模式下執行的 Agent 才能公開。",
    share: "公開 {0}", notEnforceable: "暫時無法公開：這個 Agent 還不能使用受限模式。", frozen: "已被 Hub 凍結",
    policy: "公開 {0} · 工具：{1}", noAgents: "這個 Fleet 還沒有 Agent。",
    errConflict: "這份清單在其他分頁有變更，已重新載入，請再試一次。", errUnsaved: "無法儲存這個變更。",
    errNotPaired: "請先連線到 Hub。", withdrawPending: "已在這裡撤回，連得上 Hub 時會再通知它。",
  },
});
/** hub.* words: hw("pairedTitle", name). */
export const hw = (key, ...values) => t(`hub.${key}`, ...values);

/** The Hub pages' own stylesheet, linked once (a tab opened before an upgrade has an app.css without these rules). */
export function linkHubCss(doc = typeof document !== "undefined" ? document : null) {
  try {
    if (!doc || !doc.head || doc.querySelector('link[data-hub-css="1"]')) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/hub.css"); link.setAttribute("data-hub-css", "1");
    doc.head.appendChild(link);
  } catch { /* the pages still work without it */ }
}
