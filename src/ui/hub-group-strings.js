// #3298 S-89: the words of the Hub's group permissions editor, the signed-in welcome and their discovery entries, in their own
// module so a tab holding an older hub-strings.js still draws these pages (retained-module SKEW). Experimental; off unless the
// Hub's session says `group-policy-v1`.
import { register, t } from "/assets/app-i18n.js";

register("hubGroups", {
  en: {
    // Discovery
    entryTitle: "Group permissions", entryHint: "Let members of chosen directory groups chat with agents, share agents or connect their fleet, without approving each person.",
    entryOpen: "Open group permissions", entryOpenHub: "Open on the Hub", settingsRowHint: "Set on the Hub's Administration page, signed in as its administrator.",
    experimental: "Experimental",
    // Editor
    title: "Group permissions", lead: "Members of these directory groups get these actions. Sign-in stays open to everyone in the directory; chatting with an agent still needs its owner's grant.",
    back: "Administration", unsupported: "This Hub's directory can't be used for group permissions. Group permissions need Active Directory over LDAPS (port 636).",
    repair: "The directory settings changed since group permissions were saved. Group permissions are paused until the Hub is repaired.",
    stateNever: "Off", stateEnabled: "On", stateSuspended: "Switched off — resources paused",
    stateNeverHint: "Nothing changes for anyone until you turn this on.", stateEnabledHint: "Only the actions below are allowed.",
    stateSuspendedHint: "What group permissions allowed is paused. Resume each one below, or turn group permissions on again.",
    groupsTitle: "Groups", noGroups: "No groups yet. Add a directory group by its distinguished name.",
    addLabel: "Group (distinguished name)", addPlaceholder: "CN=Hub-Members,OU=Groups,DC=example,DC=test", add: "Add group",
    resolving: "Looking up the group…", capAsk: "Chat with agents", capPublish: "Share agents", capPair: "Connect a fleet",
    fleets: "Fleets", fleetsHint: "How many fleets each member may connect (0–8).", remove: "Remove",
    notFound: "No such group in the directory.", notSecurity: "That is not a security group.", invalidDn: "That is not a distinguished name.",
    unknownGroup: "The directory didn't answer. Try again.", duplicate: "That group is already listed.",
    deniesTitle: "People excluded", deniesHint: "Exclusions win over any group.",
    previewTitle: "What this change does", previewing: "Checking who is affected…", noImpact: "No one loses anything they can do now.",
    losingActions: "Lose actions they can do now", losingPublication: "After saving, can't share new or revised agents (already shared ones stay)",
    grandfathered: "Shared agents kept as they are", suspended: "Paused by this change",
    held: "Held, unchanged: {0} people", heldHint: "AD did not report group membership for these people. Nothing changes for them now: they gain nothing and nothing of theirs is paused. They are checked again at their next action.", adminLosesChat: "After saving, you won't be able to chat with agents: you are not in a group that allows it.",
    previewStale: "Something changed since this was checked. Check again.", previewExpired: "This check expired. Check again.",
    save: "Save", saveOn: "Turn on and save", turnOff: "Turn off", turnOn: "Turn on", undo: "Undo", notSaved: "Not saved", pendingOn: "Turns on when you save.", pendingOff: "Turns off when you save; what depends on it is paused.", check: "Check what changes",
    saved: "Saved.", conflict: "Someone else changed group permissions. Reload to see their version.", failed: "Couldn't save. Try again.",
    pausedTitle: "Paused", pausedHint: "Allowed by a group before, paused now. Resume one after checking it is still wanted.", resume: "Resume", resumed: "Resumed.",
    kindFleet: "Fleet", kindExposure: "Shared agent", kindAsker: "Chat access",
    enableLater: "Turning group permissions on becomes available once the Hub's enforcement is installed.",
    // Welcome
    welcomeTitle: "Welcome, {0}", welcomeLead: "What would you like to do?",
    chatTitle: "Chat with an agent", chatHint: "Ask the agents their owners have shared with you.", chatGo: "Open chats",
    chatNone: "No agents have been shared with you yet. An agent's owner has to give you access.",
    connectTitle: "Connect your fleet", connectHint: "Pair your own AgEnD with this Hub, then choose which agents to share.", connectGo: "Connect my fleet",
    connectFleets: "Your fleets: {0} of {1}", fleetActive: "Active", fleetPaused: "Paused", fleetRevoked: "Revoked", fleetUnknown: "Can't be checked right now", connectLimit: "You have connected as many fleets as you may. Manage them, or ask your Hub admin for more.",
    connectManual: "Your Hub admin pairs fleets for you. Ask them for a pairing code.", connectNotIncluded: "Connecting a fleet is not included in your access.",
    contactAdmin: "Contact your Hub admin.", noActions: "Your account can sign in, but no actions are allowed yet.",
    unknown: "The directory didn't answer, so this can't be checked right now.", retry: "Retry", ineligible: "Your directory account can't use this right now.",
    deniedPerson: "Your Hub admin has excluded your account from this.", suspended: "Paused by your Hub admin.",
    publishNot: "Sharing agents is not included in your access.",
  },
  "zh-TW": {
    entryTitle: "群組權限", entryHint: "讓指定目錄群組的成員與 Agent 對話、分享 Agent 或連接自己的 Fleet，不必逐一核准每個人。",
    entryOpen: "開啟群組權限", entryOpenHub: "在 Hub 上開啟", settingsRowHint: "在 Hub 的「管理」頁設定，需以 Hub 管理員身分登入。",
    experimental: "實驗性",
    title: "群組權限", lead: "這些目錄群組的成員可以做下列動作。目錄中的每個人仍然都能登入；與 Agent 對話仍需要 Agent 擁有者的授權。",
    back: "管理", unsupported: "這個 Hub 的目錄無法用於群組權限。群組權限需要透過 LDAPS（連接埠 636）的 Active Directory。",
    repair: "目錄設定在群組權限儲存後改變了。在修復 Hub 之前，群組權限暫停。",
    stateNever: "關閉", stateEnabled: "開啟", stateSuspended: "已關閉——資源已暫停",
    stateNeverHint: "開啟前，任何人都不受影響。", stateEnabledHint: "只允許下列動作。",
    stateSuspendedHint: "群組權限先前允許的項目已暫停。可在下方逐一恢復，或再次開啟群組權限。",
    groupsTitle: "群組", noGroups: "還沒有群組。請用辨別名稱（DN）新增目錄群組。",
    addLabel: "群組（辨別名稱）", addPlaceholder: "CN=Hub-Members,OU=Groups,DC=example,DC=test", add: "新增群組",
    resolving: "正在查詢群組…", capAsk: "與 Agent 對話", capPublish: "分享 Agent", capPair: "連接 Fleet",
    fleets: "Fleet 數", fleetsHint: "每位成員可連接的 Fleet 數（0–8）。", remove: "移除",
    notFound: "目錄中沒有這個群組。", notSecurity: "這不是安全性群組。", invalidDn: "這不是辨別名稱。",
    unknownGroup: "目錄沒有回應，請再試一次。", duplicate: "這個群組已經在清單中。",
    deniesTitle: "排除的人", deniesHint: "排除優先於任何群組。",
    previewTitle: "這次變更的影響", previewing: "正在檢查受影響的人…", noImpact: "沒有人會失去目前能做的事。",
    losingActions: "會失去目前能做的動作", losingPublication: "儲存後，無法分享新的或修改過的 Agent（已分享的保留）",
    grandfathered: "保留原狀的已分享 Agent", suspended: "這次變更會暫停",
    held: "暫緩、維持不變：{0} 人", heldHint: "AD 沒有回報這些人的群組成員資格。現在他們不受影響：不會得到新的權限，也不會暫停他們的任何東西。下次他們操作時會再檢查一次。", adminLosesChat: "儲存後，你將無法與 Agent 對話：你不在允許對話的群組中。",
    previewStale: "檢查後有東西變了，請再檢查一次。", previewExpired: "這次檢查已過期，請再檢查一次。",
    save: "儲存", saveOn: "開啟並儲存", turnOff: "關閉", turnOn: "開啟", undo: "復原", notSaved: "尚未儲存", pendingOn: "儲存後才會開啟。", pendingOff: "儲存後才會關閉；依賴它的項目會暫停。", check: "檢查會改變什麼",
    saved: "已儲存。", conflict: "有人改了群組權限。請重新載入查看他們的版本。", failed: "無法儲存，請再試一次。",
    pausedTitle: "已暫停", pausedHint: "先前由群組允許、目前暫停。確認仍然需要後再逐一恢復。", resume: "恢復", resumed: "已恢復。",
    kindFleet: "Fleet", kindExposure: "已分享的 Agent", kindAsker: "對話權限",
    enableLater: "安裝 Hub 的權限執行功能後，才能開啟群組權限。",
    welcomeTitle: "歡迎，{0}", welcomeLead: "你想做什麼？",
    chatTitle: "與 Agent 對話", chatHint: "詢問擁有者分享給你的 Agent。", chatGo: "開啟對話",
    chatNone: "還沒有人分享 Agent 給你。需要 Agent 的擁有者給你存取權。",
    connectTitle: "連接你的 Fleet", connectHint: "將你自己的 AgEnD 與這個 Hub 配對，再選擇要分享的 Agent。", connectGo: "連接我的 Fleet",
    connectFleets: "你的 Fleet：{0} / {1}", fleetActive: "使用中", fleetPaused: "已暫停", fleetRevoked: "已撤銷", fleetUnknown: "目前無法確認", connectLimit: "你已連接允許的最多 Fleet 數。可以管理它們，或請 Hub 管理員增加。",
    connectManual: "你的 Hub 管理員會幫你配對 Fleet。請向他索取配對碼。", connectNotIncluded: "你的存取權不包含連接 Fleet。",
    contactAdmin: "請聯絡你的 Hub 管理員。", noActions: "你的帳號可以登入，但還沒有允許任何動作。",
    unknown: "目錄沒有回應，現在無法確認。", retry: "重試", ineligible: "你的目錄帳號目前無法使用這個功能。",
    deniedPerson: "Hub 管理員已將你的帳號排除在外。", suspended: "已被 Hub 管理員暫停。",
    publishNot: "你的存取權不包含分享 Agent。",
  },
});
export const hg = (key, ...values) => t(`hubGroups.${key}`, ...values);
/** This module's stylesheet, linked once when it loads (the pages work without it, plainer). */
export function linkHubGroupsCss(doc = typeof document !== "undefined" ? document : null) {
  try {
    if (!doc || !doc.head || doc.querySelector('link[data-hub-groups-css="1"]')) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/hub-groups.css"); link.setAttribute("data-hub-groups-css", "1");
    doc.head.appendChild(link);
  } catch { /* the pages still work without it */ }
}
linkHubGroupsCss();
