// #3087 review: the settings.* words that Shared agent settings (the page formerly called "Agent defaults") added or reworded,
// kept in a file of their own on purpose.
//
// Why a file of their own: a tab opened before an upgrade has already run the old settings-strings.js, and the browser hands
// the same module back when the new Settings page imports that URL again — so a key the page added would read as the raw
// "settings.…" key in a tab that opened Fleet (or search) first. This file's URL is new, so no tab can hold an old copy of it:
// every module that draws one of these words imports it, right after settings-strings.js, and register() merges its words over
// whatever that file said (the later call wins), so a reworded key also reads in its new words.
//
// Rules for this file:
// - A key lives here or in settings-strings.js, never in both. Move a key here when a change to the Shared agent settings page
//   adds it or rewords it; delete it from settings-strings.js in the same change.
// - Every module that reads one of these keys imports "./settings-shared-strings.js" after "./settings-strings.js": the
//   Settings page (panel-settings.js, settings-shared.js), the dialogs it borrows (settings-dialogs.js) and the paths outside
//   Settings that print one — search (search-dialog.js, settings-registry.js). tests/settings-shared-strings-3087.test.ts
//   checks that every module that reads a key from here imports this file.
import { register } from "/assets/app-i18n.js";

register("settings", {
  en: {
    // Reworded (settings-strings.js had these keys before; the new words win).
    dailyTips: "Daily tips (General topic)",
    dailyTipsHint: "Posts one usage tip a day in the General topic. Off stops them; /tips still posts where you call it.",
    changeInDefaults: "change in Shared agent settings",
    hangEnabled: "Hang detector",
    crossInstanceVisibility: "Bot-to-bot messages in topics",
    crossInstanceVisibilityHint: "How much of a message from one agent to another is shown in this agent's topic: all of it, one line, or nothing. Messages are always delivered; the Mirror Topic still shows them.",
    "sec_agent-defaults": "Shared agent settings",
    updateDefaults: "Update shared agent settings",
    devFormsUnsaved: "Save or discard the unsaved changes to agents, shared agent settings or connections first: this editor writes the same settings.",
    help4: "General: shared agent settings and ClassicBot defaults. Web: the dashboard's sign-in sessions, browser terminal, web echo, Log and public link. Review changes stages them.",
    // Added.
    defaultMarkTip: "Nobody set this in fleet.yaml, so the built-in value shown is in use. Editing it saves your own value.",
    // The same five, as one or two words (the hover on the usage pill lists who sets which).
    dashboardShort_appearance: "Appearance", dashboardShort_task_board: "Task board", dashboardShort_web_settings: "Web settings", dashboardShort_office: "Office", dashboardShort_office_packs: "Office packs",
    // Shared agent settings (formerly "Agent defaults"): what the page is, what each field does (the ⓘ), what an edit costs.
    sharedGroupAgents: "Shared agent settings", sharedGroupAgentsSub: "An individual agent can override these",
    sharedGroupSystem: "System & channels", sharedGroupSystemSub: "One value for the whole fleet — an agent can't change it",
    sharedGroupSystemAdvancedSub: "One value for the whole fleet — an agent can't change it, except the hang detector, which an agent can also set for itself",
    advancedCount: "Advanced ({0})",
    hostTag: "this host", switchOn: "On", switchOff: "Off", hangUnit: "minutes without output → alert", tipLabel: "About \u201c{0}\u201d",
    usageCount: "{0}/{1} in use", usageOwn: "{0} custom", usagePartly: "{0} partly custom", usageMany: "{0} agents",
    usageTipAll: "Every agent uses the value on this page.",
    usageTipOwners: "Set on their own under Agents, so a change here does not reach them: {0}.",
    usageTipParts: "An agent that sets an item on its own (under Agents) is not reached by a change to that item here; it still follows this page for its other items. Set on their own: {0}.",
    usageRooms: "{0} ClassicBot room(s) follow this value too (they are not in this count).",
    backendInfo: "Only this host is checked. For a CLI on a Windows PC, open that agent's settings and choose Change runtime / CLI.", backendInfoLink: "Windows PCs and their CLIs: Runtime",
    tipBackend: "The coding CLI an agent runs on (claude-code, codex, kiro-cli …). The installed / signed-in status beside each name is read on the machine AgEnD runs on, not on other computers.",
    tipModel: "The model an agent asks its CLI for. “CLI default” lets the CLI choose. The list follows the default backend and is read on this host.",
    tipAutoPause: "An agent idle this long is paused to free memory; a new message wakes it. 0 = never pause.",
    tipToolProgress: "How much of an agent's tool activity shows in the chat while it works. Off: nothing. Standard: short labels (“Reading a file”). Verbose: labels plus command previews.",
    tipLocale: "The language of bot replies and notices. Read when AgEnD starts. Auto follows the system.",
    tipReplyGuard: "When a person's message ends without the agent sending a reply, AgEnD nudges it to answer.",
    tipToolSet: "Which tools an agent may call. Worker is the usual one; Coordinator adds fleet management; Full allows every tool.",
    tipAgentMode: "How an agent talks to AgEnD. MCP is the default and recommended; CLI (HTTP commands) is for a CLI without MCP.",
    tipLogLevel: "How much detail an agent writes to its log. Info is normal; Debug and Trace are for troubleshooting and write a lot.",
    tipHang: "Raise an alert when an agent produces no output at all for this long. An individual agent can set its own minutes under Agents.",
    tipConcurrency: "How many agents AgEnD starts at the same time when it boots. Empty picks 2–10 from free memory and CPU cores.",
    tipStagger: "The least AgEnD waits between starting one agent and the next, in milliseconds. Default: 500.",
    seg_tool_progress_off: "Off", seg_tool_progress_standard: "Standard", seg_tool_progress_verbose: "Verbose",
    seg_visibility_full: "Full", seg_visibility_summary: "Summary", seg_visibility_hidden: "Hidden",
    seg_agent_mode_mcp: "MCP (recommended)", seg_agent_mode_cli: "CLI",
    opt_tool_set_worker: "Worker — talk, read, do the work", opt_tool_set_coordinator: "Coordinator — worker plus fleet management",
    opt_tool_set_standard: "Standard — a mid-sized set", opt_tool_set_minimal: "Minimal — only the basics", opt_tool_set_full: "Full — every tool",
    opt_log_level_trace: "Trace — everything", opt_log_level_debug: "Debug — for troubleshooting", opt_log_level_info: "Info — normal",
    opt_log_level_warn: "Warn — problems only", opt_log_level_error: "Error — failures only",
    noteRestartAgents: "↻ After saving, {0} agent(s) restart", noteSkip: " ({0} set their own — not affected)",
    noteApplyAgents: "↻ After saving, {0} agent(s) use the new value; the {1} running restart",
    noteApplyIdle: "After saving, {0} agent(s) use the new value; none is running, so none restarts",
    noteRestartRooms: "↻ After saving, {0} ClassicBot room(s) that follow this value restart",
    noteApplyRooms: "↻ After saving, {0} ClassicBot room(s) use the new value; the {1} running restart",
    noteIdleRooms: "After saving, {0} ClassicBot room(s) use the new value; none is running, so none restarts",
    noteAllOverride: "Every agent sets this on its own, so none is affected.", noteNoAgents: "No agents yet — agents you create later start with this value.",
    noteRestartFleet: "↻ AgEnD has to restart for this to take effect", noteConfirmAdmin: "A fleet admin has to confirm when you save",
    noteConfirmTick: "Newly ticked items are confirmed first",
    barRestartAgents: "↻ {0} agent(s) restart after saving", barRestartFleet: "↻ AgEnD restarts",
    barApplyAgents: "↻ {0} agent(s) use the new value; the {1} running restart", barApplyIdle: "{0} agent(s) use the new value; none is running",
    barRestartRooms: "↻ {0} ClassicBot room(s) restart after saving", barApplyRooms: "↻ {0} ClassicBot room(s) use the new value; the {1} running restart",
    barIdleRooms: "{0} ClassicBot room(s) use the new value; none is running",
    backendNotInstalledHost: "not installed on this host",
  },
  "zh-TW": {
    // 改過字句的 key（settings-strings.js 原本就有；以這裡的新字句為準）。
    dailyTips: "每日提示（General 頻道）",
    dailyTipsHint: "每天在 General 頻道發一則使用小提示。關閉就不再發；/tips 仍會發到你呼叫的聊天室。",
    changeInDefaults: "到 Agent 共用設定變更",
    hangEnabled: "卡住偵測",
    crossInstanceVisibility: "Agent 之間的訊息",
    crossInstanceVisibilityHint: "Agent 傳給 Agent 的訊息，要在這個 Agent 的主題裡顯示多少：完整、一行摘要，或不顯示。訊息一律照常送達，Mirror Topic 也照常顯示。",
    "sec_agent-defaults": "Agent 共用設定",
    updateDefaults: "更新 Agent 共用設定",
    devFormsUnsaved: "請先儲存或捨棄 Agent、Agent 共用設定或連線中未儲存的變更：這個編輯器會寫入相同的設定。",
    help4: "一般：Agent 共用設定與 ClassicBot 預設值。網頁：儀表板的登入 session、瀏覽器終端機、網頁轉發、紀錄與公開連結。「檢查變更」會把它們暫存。",
    // 新增的 key。
    defaultMarkTip: "fleet.yaml 沒有設定這一項，目前使用的是內建值。修改後會存成你自己的值。",
    dashboardShort_appearance: "外觀", dashboardShort_task_board: "任務看板", dashboardShort_web_settings: "網頁外觀設定", dashboardShort_office: "辦公室", dashboardShort_office_packs: "辦公室外觀包",
    // Agent 共用設定（原「Agent 預設值」）：這一頁是什麼、每個欄位做什麼（ⓘ）、改了會怎樣。
    sharedGroupAgents: "Agent 共用設定", sharedGroupAgentsSub: "個別 Agent 可以自己改掉",
    sharedGroupSystem: "系統與頻道", sharedGroupSystemSub: "整個 Fleet 一起，不能個別改",
    sharedGroupSystemAdvancedSub: "整個 Fleet 一起，不能個別改；只有卡住偵測可以另外在個別 Agent 設定",
    advancedCount: "進階設定（{0} 項）",
    hostTag: "此主機", switchOn: "開", switchOff: "關", hangUnit: "分鐘沒輸出就提醒", tipLabel: "「{0}」的說明",
    usageCount: "{0}/{1} 套用中", usageOwn: "{0} 自訂", usagePartly: "{0} 部分自訂", usageMany: "{0} 個 Agent",
    usageTipAll: "所有 Agent 都用這裡的值。",
    usageTipOwners: "在 Agents 頁自己設定了這一項，這裡改了不影響它們：{0}。",
    usageTipParts: "Agent 在 Agents 頁自己設定了某一項，這裡改那一項就不會影響它；其他項目仍然跟著這裡。自己設定的：{0}。",
    usageRooms: "另有 {0} 個 ClassicBot 房間也沿用這個值（不在上面的數字裡）。",
    backendInfo: "只檢查這台主機。Windows 電腦上的 CLI，請在個別 Agent 的設定裡按「切換 Runtime／CLI」。", backendInfoLink: "查看 Windows 電腦與 CLI：Runtime",
    tipBackend: "Agent 用哪一種 coding CLI 執行（claude-code、codex、kiro-cli…）。每個名稱旁的「已安裝／已登入」狀態，是在 AgEnD 所在的這台主機上檢查的，不包含其他電腦。",
    tipModel: "Agent 向 CLI 要求使用的模型。「CLI 自己的預設」就是讓 CLI 自己決定。清單跟著預設後端換，內容是這台主機上讀到的。",
    tipAutoPause: "Agent 閒置這麼久就暫停、釋放記憶體，有新訊息會自動喚醒。0＝不自動暫停。",
    tipToolProgress: "Agent 工作時，聊天室顯示多少工具活動。關：不顯示。標準：簡短說明（例如「正在讀取檔案」）。詳細：說明加上指令預覽。",
    tipLocale: "Bot 回覆與通知使用的語言。AgEnD 啟動時讀取。「自動」會跟隨系統。",
    tipReplyGuard: "使用者的訊息處理完卻沒有回覆時，AgEnD 會提醒 Agent 補上回覆。",
    tipToolSet: "Agent 可以呼叫哪些工具。Worker 最常用；Coordinator 多了管理 Fleet 的工具；Full 全部開放。",
    tipAgentMode: "Agent 跟 AgEnD 溝通的方式。MCP 是預設、建議；CLI（HTTP 指令）給不支援 MCP 的 CLI 用。",
    tipLogLevel: "Agent 的 log 寫多詳細。Info 是一般；Debug、Trace 用來除錯，會寫很多。",
    tipHang: "Agent 超過這段時間完全沒有輸出，就發出提醒。個別 Agent 可以在 Agents 頁自己設定分鐘數。",
    tipConcurrency: "AgEnD 開機時同時啟動幾個 Agent。留空會依可用記憶體與 CPU 核心數在 2–10 之間自動決定。",
    tipStagger: "啟動一個 Agent 到下一個之間至少等多久（毫秒）。預設：500。",
    seg_tool_progress_off: "關", seg_tool_progress_standard: "標準", seg_tool_progress_verbose: "詳細",
    seg_visibility_full: "完整", seg_visibility_summary: "摘要", seg_visibility_hidden: "隱藏",
    seg_agent_mode_mcp: "MCP（建議）", seg_agent_mode_cli: "CLI",
    opt_tool_set_worker: "Worker — 溝通、讀取、做事", opt_tool_set_coordinator: "Coordinator — Worker 加上管理 Fleet",
    opt_tool_set_standard: "Standard — 中等規模", opt_tool_set_minimal: "Minimal — 只有最基本的", opt_tool_set_full: "Full — 全部工具",
    opt_log_level_trace: "Trace — 全部", opt_log_level_debug: "Debug — 除錯用", opt_log_level_info: "Info — 一般",
    opt_log_level_warn: "Warn — 只記問題", opt_log_level_error: "Error — 只記失敗",
    noteRestartAgents: "↻ 儲存後，{0} 個 Agent 會重新啟動", noteSkip: "（{0} 自訂，不受影響）",
    noteApplyAgents: "↻ 儲存後，{0} 個 Agent 會套用新值，其中執行中的 {1} 個會重新啟動",
    noteApplyIdle: "儲存後，{0} 個 Agent 會套用新值；目前都沒有執行中，所以不會重新啟動",
    noteRestartRooms: "↻ 儲存後，沿用這個值的 {0} 個 ClassicBot 房間會重新啟動",
    noteApplyRooms: "↻ 儲存後，{0} 個 ClassicBot 房間會套用新值，其中執行中的 {1} 個會重新啟動",
    noteIdleRooms: "儲存後，{0} 個 ClassicBot 房間會套用新值；目前都沒有執行中，所以不會重新啟動",
    noteAllOverride: "每個 Agent 都自己設定了這一項，所以都不受影響。", noteNoAgents: "目前還沒有 Agent；之後新建的會使用這個值。",
    noteRestartFleet: "↻ 需要重新啟動 AgEnD 才生效", noteConfirmAdmin: "儲存時需要 Fleet 管理員確認",
    noteConfirmTick: "勾選的項目要先確認才生效",
    barRestartAgents: "↻ 儲存後 {0} 個 Agent 會重新啟動", barRestartFleet: "↻ 需要重新啟動 AgEnD",
    barApplyAgents: "↻ {0} 個 Agent 會套用新值，其中執行中的 {1} 個會重新啟動", barApplyIdle: "{0} 個 Agent 會套用新值，目前都沒有執行中",
    barRestartRooms: "↻ 儲存後 {0} 個 ClassicBot 房間會重新啟動", barApplyRooms: "↻ {0} 個 ClassicBot 房間會套用新值，其中執行中的 {1} 個會重新啟動",
    barIdleRooms: "{0} 個 ClassicBot 房間會套用新值，目前都沒有執行中",
    backendNotInstalledHost: "此主機未安裝",
  },
});
