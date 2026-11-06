// #3160: Follow agent's words, in their own module (a new URL, so a page that cached an older workspace-strings.js
// still gets them — never a raw key). Registered by workspace-panel.js.
import { register } from "/assets/app-i18n.js";

register("chat", {
  en: {
    wsFollow: "Follow agent", wsFollowing: "Following", wsFollowPaused: "Paused · Resume",
    wsFollowTitle: "Show the file the agent is reading, editing or searching, as it works",
    wsFollowPausedTitle: "You moved, so Follow paused. Click to follow the agent again",
    wsFollowNotHere: "Follow works for Claude Code and Codex agents",
    wsFollowNotRunning: "The agent isn't running", wsFollowIdle: "Waiting for the agent to read or edit a file…",
    wsThisTurn: "This turn", wsKind_read: "Read", wsKind_edit: "Edit", wsKind_search: "Search", wsKind_list: "List",
    wsBestEffort: "From a shell command, so this is a best guess", wsHiddenStep: "A hidden file (its contents are never shown)",
    wsFollowHlRead: "Lines the agent read", wsFollowHlEdit: "Lines the agent changed",
  },
  "zh-TW": {
    wsFollow: "跟隨 Agent", wsFollowing: "跟隨中", wsFollowPaused: "已暫停 · 繼續",
    wsFollowTitle: "Agent 工作時，顯示它正在讀、改或搜尋的檔案",
    wsFollowPausedTitle: "你動了畫面，所以先暫停跟隨。按一下繼續跟隨 Agent",
    wsFollowNotHere: "跟隨只支援 Claude Code 與 Codex 的 Agent",
    wsFollowNotRunning: "Agent 沒有在執行", wsFollowIdle: "等 Agent 讀取或修改檔案…",
    wsThisTurn: "這一輪", wsKind_read: "讀取", wsKind_edit: "修改", wsKind_search: "搜尋", wsKind_list: "列出",
    wsBestEffort: "來自 shell 指令，只是推測", wsHiddenStep: "隱藏的檔案（內容一律不顯示）",
    wsFollowHlRead: "Agent 讀過的行", wsFollowHlEdit: "Agent 改過的行",
  },
});
