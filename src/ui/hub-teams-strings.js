import { register, t } from "/assets/app-i18n.js";
register("hubTeam", {
  en: {
    title: "Teams", mine: "My teams", manage: "Manage teams", lead: "AD groups stop at departments. A team is a list you pick, usable for rooms and for who may ask.",
    pageLead: "Pick the people in each team. Rooms keep the people added at that moment; asking permissions and room-creation rights follow the current roster.",
    myLead: "Manage the members of the teams you lead. A Hub administrator manages the name, department and lead.",
    create: "New team", edit: "Edit {0}", empty: "No teams yet.", noMine: "You do not lead any teams.", loading: "Loading teams…", retry: "Try again", refresh: "Refresh", back: "All teams",
    name: "Team name", department: "Department", departmentLine: "Department: {0}", chooseDepartment: "Choose a department", departmentQuery: "Search AD departments", leadPerson: "Lead", chooseLead: "Choose a lead",
    members: "Members", role: "Role", roleLead: "Lead", roleMember: "Member", signedIn: "Joined Hub", agents: "Shared agents", yes: "Yes", notYet: "Not yet", unobserved: "Not checked yet", none: "None",
    add: "Add member", remove: "Remove", search: "Search", personQuery: "Search everyone by name", searchHint: "Type 2 to 64 characters. People in any department can be selected.", groupHint: "Type 2 to 64 characters of the department name.",
    searching: "Searching…", noMatches: "No matches. Try more of the name.", choose: "Choose {0}", pick: "Choose", cancel: "Cancel", change: "Change", save: "Save", saving: "Saving…", saved: "Saved.", unsaved: "Unsaved changes",
    limit: "Up to 200 members, including the lead.", count: "{0} members", leadRequired: "The lead is always a member. Choose another lead before removing this person.",
    disabledLead: "The lead's directory account is disabled. Choose a new lead.",
    failed: "Teams could not be loaded. Try again.", searchFailed: "The directory could not be searched. Try again.", busy: "The Hub is busy. Try again shortly.", denied: "Your access changed. Refresh to check the current team.", saveFailed: "Your changes could not be saved. They are still here; refresh if someone else changed the team.",
    delete: "Delete team", deleteTitle: "Delete {0}?", deleteLead: "These team-based permissions will stop applying. Existing room members and agents already accepted into rooms stay.", noImpact: "No active team grants or room-creation entry.", creators: "May create rooms", grantExpiry: "May ask {0} · until {1}",
    styleLoading: "Loading the team editor…", styleFailed: "The team editor could not be loaded. Try again.",
  },
  "zh-TW": {
    title: "團隊", mine: "我的團隊", manage: "管理團隊", lead: "AD 群組只到部門。團隊是你自己挑的一份名單，可以用在房間與提問權限。",
    pageLead: "選擇各團隊的成員。加入房間時會保留當下的名單；提問權限與建立房間的權限則依團隊目前的成員判斷。",
    myLead: "管理你負責的團隊成員。名稱、所屬部門與負責人由 Hub 管理員設定。",
    create: "新增團隊", edit: "編輯 {0}", empty: "還沒有團隊。", noMine: "你目前沒有負責的團隊。", loading: "正在讀取團隊…", retry: "再試一次", refresh: "重新整理", back: "所有團隊",
    name: "團隊名稱", department: "所屬部門", departmentLine: "所屬部門：{0}", chooseDepartment: "選擇部門", departmentQuery: "搜尋 AD 部門", leadPerson: "負責人", chooseLead: "選擇負責人",
    members: "成員", role: "身分", roleLead: "負責人", roleMember: "成員", signedIn: "已加入 Hub", agents: "分享的 Agent", yes: "已加入", notYet: "尚未加入", unobserved: "尚未確認", none: "無",
    add: "加入成員", remove: "移除", search: "搜尋", personQuery: "輸入姓名搜尋所有人", searchHint: "請輸入 2 到 64 個字，可以選擇其他部門的同仁。", groupHint: "請輸入部門名稱的 2 到 64 個字。",
    searching: "搜尋中…", noMatches: "找不到符合的對象，請多輸入幾個姓名的字。", choose: "選擇 {0}", pick: "選擇", cancel: "取消", change: "變更", save: "儲存", saving: "儲存中…", saved: "已儲存。", unsaved: "尚未儲存",
    limit: "最多 200 位成員，包含負責人。", count: "{0} 位成員", leadRequired: "負責人一定是成員，請先指定另一位負責人才能移除。",
    disabledLead: "負責人的帳號已停用，請指定新的負責人。",
    failed: "無法讀取團隊，請再試一次。", searchFailed: "目前無法搜尋目錄，請再試一次。", busy: "Hub 目前忙碌，請稍後再試。", denied: "你的權限已變更，請重新整理確認目前的團隊。", saveFailed: "無法儲存變更，編輯內容仍保留；若團隊已被其他人變更，請重新整理。",
    delete: "刪除團隊", deleteTitle: "刪除「{0}」？", deleteLead: "以下以團隊授予的權限將停止適用。已加入房間的成員與已同意加入的 Agent 都會保留。", noImpact: "沒有有效的團隊授權或建立房間權限。", creators: "可以建立房間", grantExpiry: "可以問 {0} · 到 {1}",
    styleLoading: "正在載入團隊編輯器…", styleFailed: "無法載入團隊編輯器，請再試一次。",
  },
});
export const ht = (key, ...args) => t(`hubTeam.${key}`, ...args);
