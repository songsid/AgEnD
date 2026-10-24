// #2347 §6: the settings registry — one entry per setting, for Settings' search and the Ctrl K "Settings" group: where it
// is (its section, and the element to bring into view), what it is called in both languages (a settings string key,
// `labelKey`, or `label`), its config key, and the words people search with (synonyms, in both languages). A test
// mounts every section and checks each field drawn has an entry, and each entry's element is drawn in its section.
import { lang, tIn } from "/assets/app-i18n.js";
import { sectionPath } from "/assets/app-route.js";
import { navigate } from "/assets/app-nav.js";
import "./settings-strings.js";
import "./chat-strings.js";
import { GUESTS_SETTINGS } from "./settings-guests.js";

const L = (en, zh) => ({ en, "zh-TW": zh });
/** [id, section, target, labelKey | label, config key, words en, words zh] */
const ROWS = [
  // You · Preferences
  ["profile.name", "preferences", "#profile-name", "settings.profileTitle", null, ["name", "display name", "who agents see", "profile"], ["名字", "名稱", "顯示名稱", "個人資料"]],
  ["prefs.theme", "preferences", "#pref-theme", "app.theme", null, ["theme", "dark", "light", "dark mode", "colour scheme"], ["主題", "深色", "淺色", "外觀"]],
  ["prefs.lang", "preferences", "#pref-lang", "app.language", null, ["language", "dashboard language", "english", "chinese", "locale"], ["語言", "介面語言", "中文", "英文"]],
  ["prefs.names", "preferences", "#pref-names", "app.names", null, ["names", "nickname", "real name", "instance name", "display"], ["名稱", "暱稱", "實名"]],
  ["prefs.previews", "preferences", "#pref-previews", "chat.previews", null, ["html preview", "preview", "iframe"], ["預覽", "HTML 預覽"]],
  ["prefs.tour", "preferences", "#tourBtn", "chat.tour", null, ["tour", "help", "walkthrough", "guide"], ["導覽", "說明", "教學"]],
  ["device.motion", "preferences", "#fx-follow-reduced-motion", "settings.themesFollowMotion", null, ["reduced motion", "animation", "effects", "accessibility"], ["減少動態", "動畫", "特效", "無障礙"]],
  ["device.css-off", "preferences", "#css-off-here", "settings.cssDeviceOff", null, ["custom css", "css off", "this device", "safe"], ["自訂 CSS", "關閉 CSS", "這個裝置"]],
  // You · Look
  ["look.themes", "look", "#fx-show-themes", "settings.themesShow", "fx.show", ["agent themes", "themes", "effects", "widgets"], ["主題", "agent 的主題", "特效", "小工具"]],
  ["look.colours", "look", ".s-colors", "settings.colorTitle", "color.show", ["identity colour", "color", "colour", "turn off colours"], ["識別色", "顏色", "關閉顏色"]],
  ["look.cards", "look", ".s-card-size", "settings.cardSizeTitle", "card.size", ["identity card", "card size", "portrait", "banner"], ["身分卡", "卡片大小"]],
  ["look.widget", "look", ".s-widget", "settings.widgetTitle", "widget.sidebar", ["sidebar widget", "widget", "json"], ["側邊欄小工具", "小工具"]],
  ["look.css", "look", ".s-owner-css", "settings.cssTitle", null, ["custom css", "stylesheet", "style", "css"], ["自訂 CSS", "樣式表", "樣式"]],
  ["look.mods", "look", ".s-mods", "settings.modsTitle", null, ["mod", "mods", "import", "add-on", "agendmod"], ["mod", "匯入", "擴充"]],
  ["look.effects", "look", ".s-effects", null, null, ["effects", "canvas", "ambient", "petals", "click stars"], ["特效", "效果", "花瓣", "氛圍"], L("Effects", "效果")],
  ["look.restore", "look", ".s-restore", "settings.restoreTitle", null, ["restore defaults", "reset", "default"], ["還原預設值", "重設", "預設"]],
  // Fleet · Agents
  ["agents.new", "agents", "#newAgentBtn", "settings.newAgent", null, ["new agent", "create", "add agent", "instance"], ["新增 agent", "建立", "新 agent"]],
  ["agents.provider-keys", "agents", ".s-provider-keys", "settings.providerKeys", "web.provider_secrets", ["api key", "provider", "openai", "anthropic", "token", "secret"], ["API 金鑰", "金鑰", "供應商", "token"]],
  ["defaults.tips", "agent-defaults", "#g-tips", "settings.dailyTips", "defaults.tips", ["daily tips", "dm", "notices"], ["每日提示", "私訊"]],
  ["web.notify-login", "access", "#webNotifyLogin", "settings.webNotifyLogin", "web.notify_login", ["sign in", "login", "dm", "notices"], ["登入通知", "私訊"]],
  // Fleet · Agent defaults
  ["defaults.locale", "agent-defaults", "#g-locale", "settings.language", "defaults.locale", ["language", "bot language", "reply language", "locale"], ["語言", "回覆語言", "bot 語言"]],
  ["defaults.backend", "agent-defaults", "#g-be", "settings.defaultBackend", "defaults.backend", ["backend", "cli", "claude", "codex", "kiro"], ["後端", "CLI"]],
  ["defaults.model", "agent-defaults", "#g-model", "settings.defaultModel", "defaults.model", ["model", "opus", "sonnet", "gpt"], ["模型"]],
  ["defaults.auto-pause", "agent-defaults", "#g-auto", "settings.autoPause", "defaults.auto_pause_after", ["auto pause", "idle", "sleep", "minutes"], ["自動暫停", "閒置", "休眠"]],
  ["defaults.tool-progress", "agent-defaults", "#g-tp", "settings.toolProgress", "defaults.tool_progress", ["tool progress", "verbose", "steps"], ["工具進度", "詳細"]],
  ["defaults.visibility", "agent-defaults", "#g-vis", "settings.crossInstanceVisibility", "defaults.cross_instance_visibility", ["visibility", "bot to bot", "cross instance", "messages"], ["可見性", "bot 之間", "跨 instance"]],
  ["defaults.reply-triggers", "agent-defaults", "#g-reply-triggers", "settings.replyTriggers", "defaults.reply_triggers", ["classic native reply", "reply trigger"], ["原生回覆觸發"]],
  ["chat.classic-reply-triggers", "chat", "#g-creply-triggers", "settings.replyTriggers", "classic_defaults.reply_triggers", ["classic native reply"], ["ClassicBot 原生回覆觸發"]],
  ["defaults.reply-guard", "agent-defaults", "#g-reply", "settings.replyCompletionGuard", "defaults.reply_completion_guard", ["delivered reply", "reply guard", "require reply"], ["送達回覆", "回覆保護"]],
  ["defaults.tool-set", "agent-defaults", "#g-ts", "settings.toolSet", "defaults.tool_set", ["tool set", "tools", "mcp"], ["工具組", "工具"]],
  ["defaults.dashboard", "agent-defaults", "#g-dash", "settings.dashboardAccess", "defaults.dashboard", ["dashboard access", "dashboard features", "permissions", "appearance tools", "task board", "web settings"], ["Dashboard 權限", "權限", "外觀", "任務看板", "網頁設定"]],
  ["defaults.log-level", "agent-defaults", "#g-ll", "settings.logLevel", "defaults.log_level", ["log level", "debug", "logging"], ["記錄層級", "除錯", "日誌"]],
  ["defaults.agent-mode", "agent-defaults", "#g-am", "settings.agentMode", "defaults.agent_mode", ["agent mode", "mcp", "cli"], ["agent 模式"]],
  ["defaults.hang-on", "agent-defaults", "#g-hang-on", "settings.hangEnabled", "defaults.hang_detector.enabled", ["hang detector", "stuck", "frozen"], ["卡住偵測", "卡住", "當機"]],
  ["defaults.hang-timeout", "agent-defaults", "#g-hang", "settings.hangTimeout", "defaults.hang_detector.timeout_minutes", ["hang timeout", "stuck", "minutes"], ["卡住逾時", "逾時"]],
  ["defaults.concurrency", "agent-defaults", "#g-conc", "settings.concurrency", "startup.concurrency", ["startup", "concurrency", "parallel", "spawn"], ["啟動", "並行"]],
  ["defaults.project-roots", "agent-defaults", "#g-roots", "settings.projectRootsTitle", "project_roots", ["project roots", "folders", "directory", "where agents work", "working directory"], ["專案資料夾", "資料夾", "目錄", "工作目錄"]],
  ["defaults.stagger", "agent-defaults", "#g-stag", "settings.staggerDelay", "startup.stagger_delay_ms", ["startup", "stagger", "delay"], ["啟動", "間隔", "延遲"]],
  // Fleet · Chat & connections
  ["chat.new-connection", "chat", "#newBotBtn", "settings.newBot", "channels", ["new connection", "bot", "telegram", "discord", "bot token", "token"], ["新增連線", "bot", "Telegram", "Discord", "bot token", "token"]],
  ["chat.web-echo", "chat", "#webEchoToChannel", "settings.webEcho", "web.echo_to_channel", ["web echo", "mirror", "copy to chat", "echo"], ["網頁轉發", "轉發", "同步到聊天"]],
  ["chat.classic-rooms", "chat", "#classicbot", "settings.classicChannels", null, ["classicbot", "rooms", "channels"], ["ClassicBot", "房間", "頻道"]],
  ["chat.classic-backend", "chat", "#g-cbe", "settings.classicBackend", "classic_defaults.backend", ["classicbot backend", "backend"], ["ClassicBot 後端", "後端"]],
  ["chat.classic-tool-progress", "chat", "#g-ctp", "settings.toolProgress", "classic_defaults.tool_progress", ["classicbot tool progress", "tool progress"], ["ClassicBot 工具進度", "工具進度"]],
  ["chat.classic-reply-guard", "chat", "#g-creply", "settings.replyCompletionGuard", "classic_defaults.reply_completion_guard", ["classicbot delivered reply", "reply guard"], ["ClassicBot 送達回覆"]],
  ["chat.classic-admins", "chat", "#g-admins", "settings.classicAdmins", "classic.admin_users", ["classicbot admins", "who can use classicbot", "admin"], ["ClassicBot 管理員", "誰可以使用 ClassicBot", "管理員"]],
  ["chat.classic-guilds", "chat", "#g-guilds", "settings.allowedGuilds", "classic.allowed_guilds", ["discord server", "guild", "allowed servers"], ["Discord 伺服器", "伺服器"]],
  // Fleet · Web dashboard
  ["dash.log-tab", "web-dashboard", "#webLogTab", "settings.webLogTab", "web.log_tab", ["log tab", "steps", "log"], ["Log 分頁", "紀錄", "步驟"]],
  ["dash.usage-public", "web-dashboard", "#webUsagePublic", "settings.webUsagePublic", "web.usage_report_on_public_link", ["usage", "public link", "cost", "tokens"], ["用量", "公開連結", "費用"]],
  ["dash.app-icon", "web-dashboard", ".s-app-icon", "settings.appIconTitle", null, ["app icon", "favicon", "home screen", "icon"], ["App 圖示", "圖示", "主畫面"]],
  ["dash.card-limits", "web-dashboard", ".s-card-limits", "settings.cardLimitsTitle", "web.appearance", ["upload limits", "portrait", "banner", "card limits"], ["上傳限制", "身分卡上傳限制"]],
  ["dash.canvas-worker", "web-dashboard", ".s-experimental-effects", "experimentalEffects.title", "web.experimental.canvas_worker", ["canvas worker", "experimental", "effects"], ["Canvas Worker", "實驗功能", "特效"]],
  // Fleet · Access & security
  ["access.session-absolute", "access", "#webSessionAbsolute", "settings.sessionAbsolute", "web.session.local.absolute_hours", ["session", "sign in", "hours", "expire", "logout"], ["session", "登入", "時數", "到期"]],
  ["access.session-idle", "access", "#webSessionIdle", "settings.sessionIdle", "web.session.local.idle_hours", ["session", "idle", "unused", "hours"], ["session", "閒置", "時數"]],
  ["access.terminal", "access", "#webTerminalEnabled", "settings.webTerminalEnabled", "web_terminal.enabled", ["browser terminal", "terminal", "login", "shell"], ["瀏覽器終端機", "終端機", "登入"]],
  ["access.terminal-ttl", "access", "#webTerminalTtl", "settings.webTerminalTtl", "web_terminal.ttl_minutes", ["terminal minutes", "terminal", "ttl"], ["終端機", "分鐘"]],
  ["access.public-link", "access", "#publicWebLink", "settings.publicLink", "web.public_link.allow_public", ["public link", "share", "tunnel", "cloudflare", "trycloudflare"], ["公開連結", "分享", "tunnel"]],
  ["access.hostname", "access", "#publicWebHostname", "settings.namedHostname", "web.public_link.hostname", ["fixed address", "domain", "hostname", "named tunnel", "https"], ["固定網址", "網域", "主機名稱", "具名 tunnel"]],
  ["access.origin-port", "access", "#publicWebOriginPort", "settings.namedOriginPort", "web.public_link.origin_port", ["port", "origin port", "fixed address"], ["連接埠", "port", "固定網址"]],
  ["access.public-ttl", "access", "#publicWebTtl", "settings.publicTtl", "web.public_link.ttl_minutes", ["public link minutes", "how long", "ttl", "no expiry", "expire"], ["公開連結", "分鐘", "多久", "不過期", "到期"]],
  // Shown with a fixed hostname (a named tunnel), or while it is set.
  ["access.public-auto-open", "access", "#publicAutoOpen", "settings.publicAutoOpen", "web.public_link.auto_open", ["reopen after restart", "auto open", "public link", "named link"], ["重新開啟", "自動開啟", "公開連結", "固定網域"]],
  ["access.protocol", "access", "#publicWebProtocol", "settings.publicProtocol", "web.public_link.protocol", ["protocol", "http2", "quic", "https"], ["通訊協定", "協定"]],
  ["access.cloudflare-token", "access", "#publicTunnelToken", "settings.namedToken", "web.public_link.tunnel_token_env", ["cloudflare token", "tunnel token", "token", "fixed address", "secret"], ["Cloudflare token", "tunnel token", "token", "固定網址", "金鑰"]],
  ["access.authority", "access", "#vaEnabled", "settings.vaEnabled", "web.verified_authority.enabled", ["web authority", "verified", "authorize"], ["網頁授權", "驗證", "授權"]],
  ["access.authority-loopback", "access", "#vaLoopbackOnly", "settings.vaLoopbackOnly", "web.verified_authority.loopback_only", ["only this computer", "loopback", "authorize"], ["只有這台電腦", "授權"]],
  // #2453: shown with a fixed hostname (a named tunnel), or while it is on; its label names the hostname, so its own words here.
  ["access.authority-named-link", "access", "#vaNamedLink", null, "web.verified_authority.named_link", ["named link", "my named link", "authorize", "fixed hostname"], ["固定網域", "授權", "named link"], L("Also over my named link", "也允許透過我的固定網域")],
  ["access.authority-quick-link", "access", "#vaQuickLink", null, "web.verified_authority.quick_link", ["temporary public link", "quick link", "quick tunnel", "authorize", "trycloudflare"], ["臨時公開連結", "授權", "quick tunnel"], L("Also over the temporary public link", "也允許透過臨時公開連結")],
  ["access.authority-hours", "access", "#vaHours", null, "web.verified_authority.max_session_hours", ["authorization hours", "how long", "authority"], ["授權時數", "多久"], L("How long a web authorization lasts", "網頁授權持續多久")],
  ["access.authority-revoke", "access", "#vaRevoke", "settings.vaRevoke", null, ["revoke", "sign out", "authority"], ["撤銷", "登出", "授權"]],
  // Fleet · Advanced
  ["advanced.fleet-yaml", "advanced", ".s-dev", null, null, ["fleet.yaml", "yaml", "json", "raw", "edit config"], ["fleet.yaml", "YAML", "設定檔"], L("fleet.yaml (YAML / JSON)", "fleet.yaml（YAML / JSON）")],
  ["advanced.read-only", "advanced", ".s-web-ro", "settings.webReadOnlyTitle", null, ["allowed hosts", "view access", "preview port", "read only", "web settings"], ["allowed hosts", "唯讀", "網頁設定"]],
];

export const SETTINGS_REGISTRY = Object.freeze([
  ...ROWS.map(([id, section, target, labelKey, key, en, zh, label]) => Object.freeze({ id, section, target, labelKey, label: label || null, key, words: { en, "zh-TW": zh } })),
  // dev-claude2's Guests section (#2348): its entries, brought to the same shape (the card itself is the target).
  ...GUESTS_SETTINGS.map((g) => Object.freeze({ id: g.id, section: g.section, target: g.id === "guests.enabled" ? "#guestsEnabled" : g.id === "guests.chat" ? "#guestsChat" : "#guests",
    labelKey: null, label: g.label, key: g.key || null, words: g.words })),
]);

/** An entry's name in a language. */
export function settingLabel(entry, language = lang()) {
  return entry.label ? entry.label[language] || entry.label.en : tIn(language, entry.labelKey);
}

const fold = (s) => String(s || "").toLowerCase().normalize("NFKC");
/**
 * Entries matching `query`: every word in it is found in the entry's name (either language), its config key, or its
 * words (either language). Ranked: a name that starts with it, then one that contains it, then a config key, then a word.
 */
export function searchSettings(query) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored = [];
  for (const entry of SETTINGS_REGISTRY) {
    const names = [settingLabel(entry, "en"), settingLabel(entry, "zh-TW")].map(fold);
    const keys = fold(entry.key || "");
    const words = [...(entry.words.en || []), ...(entry.words["zh-TW"] || [])].map(fold);
    let score = 0, all = true;
    for (const term of terms) {
      const s = names.some((n) => n.startsWith(term)) ? 4 : names.some((n) => n.includes(term)) ? 3 : keys.includes(term) ? 2 : words.some((w) => w.includes(term)) ? 1 : 0;
      if (!s) { all = false; break; }
      score += s;
    }
    if (all) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.entry);
}

// The setting a search result opened, brought into view once its section is drawn (the panel asks for it).
let pending = null;
/** Go to a setting: its section, then (once drawn) the setting itself, focused and flashed. */
export function goToSetting(entry) {
  pending = entry ? entry.target : null;
  navigate(sectionPath(entry.section));
}
/** Go to a section and, once it is drawn, to one element in it (a field the bar says to fix). */
export function goToTarget(section, target) {
  pending = target || null;
  navigate(sectionPath(section));
}
/** The element a search result asked for, once (null: none). */
export function takePendingSetting() { const p = pending; pending = null; return p; }
