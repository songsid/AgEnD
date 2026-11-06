// #3153 P1: the Files & changes panel's own words, registered by its module (workspace-panel.js). A page that opened
// Log or Details before an upgrade may hold an older chat-strings.js without them; these keep the panel and the ⋯
// entry saying what they are, never a raw key (the lesson of #3155).
import { register } from "/assets/app-i18n.js";

register("chat", {
  en: {
    wsOpen: "Files & changes", wsTitle: "Files & changes", wsChanges: "Changes", wsFiles: "Files", wsRefresh: "Refresh",
    wsReadOnly: "Read-only view of the folder this agent works in. Secret-looking files (.env, keys, credentials) are hidden.",
    wsNoRepo: "This folder is not a git repository, so there are no changes to show. Files still works.",
    wsClean: "No uncommitted changes on {0}.", wsSummary: "{0} changed files on {1}", wsHiddenCount: "{0} hidden",
    wsCut: "Some changes are not shown: the list or the diff reached its size limit.",
    wsHiddenFile: "hidden: may contain secrets", wsBinary: "binary", wsTooLarge: "too large to show", wsLink: "link (not followed)",
    wsSt_modified: "M", wsSt_added: "A", wsSt_deleted: "D", wsSt_untracked: "U",
    wsDirCut: "Only the first 1,000 entries are listed.", wsEmptyDir: "This folder is empty.",
    wsBinaryFile: "A binary file ({0}): not shown.", wsTooLargeFile: "Too large to show here ({0}).",
    wsNotOffered: "Files & changes are not available for this agent (General, coordinators and agents on another computer).",
    wsNotFound: "The folder or file was not found.", wsHidden: "Hidden: it may contain secrets.", wsSymlink: "A link: not followed.",
    wsOutside: "Outside the agent's folder.", wsNotAFile: "Not a regular file.", wsFailed: "Couldn't read it. Try Refresh.",
  },
  "zh-TW": {
    wsOpen: "檔案與變更", wsTitle: "檔案與變更", wsChanges: "變更", wsFiles: "檔案", wsRefresh: "重新整理",
    wsReadOnly: "這是 Agent 工作資料夾的唯讀檢視。看起來像機密的檔案（.env、金鑰、憑證）會隱藏。",
    wsNoRepo: "這個資料夾不是 git 儲存庫，沒有可顯示的變更；「檔案」仍可使用。",
    wsClean: "{0} 沒有尚未提交的變更。", wsSummary: "{0} 個檔案有變更（{1}）", wsHiddenCount: "{0} 個已隱藏",
    wsCut: "部分變更未顯示：清單或差異已達大小上限。",
    wsHiddenFile: "已隱藏：可能含有機密", wsBinary: "二進位檔", wsTooLarge: "太大，無法顯示", wsLink: "連結（不追蹤）",
    wsSt_modified: "M", wsSt_added: "A", wsSt_deleted: "D", wsSt_untracked: "U",
    wsDirCut: "只列出前 1,000 個項目。", wsEmptyDir: "這個資料夾是空的。",
    wsBinaryFile: "二進位檔（{0}），不顯示。", wsTooLargeFile: "太大，無法在這裡顯示（{0}）。",
    wsNotOffered: "這個 Agent 無法使用「檔案與變更」（General、協調者與其他電腦上的 Agent）。",
    wsNotFound: "找不到這個資料夾或檔案。", wsHidden: "已隱藏：可能含有機密。", wsSymlink: "這是連結，不追蹤。",
    wsOutside: "在 Agent 的資料夾之外。", wsNotAFile: "不是一般檔案。", wsFailed: "無法讀取，請按「重新整理」。",
  },
});
