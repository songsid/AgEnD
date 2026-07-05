/**
 * Backend i18n for user-facing strings (Telegram/Discord replies, slash
 * descriptions, notifications). The active locale is process-global — set once
 * at fleet start from fleet.yaml `defaults.locale` (or timezone detection) via
 * {@link setLocale} — so call sites just use {@link t} without threading it.
 */
export type Locale = "en" | "zh-TW";

let current: Locale = "en";
export function setLocale(l: Locale): void { current = l; }
export function getLocale(): Locale { return current; }

/** UTC offset in hours (e.g. +8 for Asia/Taipei). */
export function detectTimezone(): number {
  return -(new Date().getTimezoneOffset() / 60);
}

/** fleet.yaml locale > timezone +8 → zh-TW > fallback en. */
export function detectLocale(fleetConfig?: { defaults?: { locale?: string } }): Locale {
  const cfg = fleetConfig?.defaults?.locale;
  if (cfg === "zh-TW" || cfg === "en") return cfg;
  return detectTimezone() === 8 ? "zh-TW" : "en";
}

const messages: Record<Locale, Record<string, string>> = {
  en: {
    "cancel.button": "🛑 Cancel",
    "cancel.sent": "🛑 Sent cancel to {0}.",
    "cancel.not_running": "❌ {0} not running.",
    "ctx.used": "📊 Context: {0}% used",
    "ctx.backend": "Backend: {0}",
    "ctx.instance": "Instance: {0}",
    "ctx.unavailable": "Context info not available yet.",
    "classic.already_active": "This channel already has an active agent. Use /chat to talk.",
    "classic.topic_bound": "This channel is already bound to a topic-mode instance.",
    "classic.not_authorized_guild": "⛔ This server is not in the allowed guilds list.",
    "classic.no_agent": "No active agent in this channel.",
    "classic.no_agent_start": "No active agent in this channel. Use /start first.",
    "classic.started": "✅ Agent started in this channel. Use `/chat <message>` or @mention to talk.",
    "classic.stopped": "🛑 Agent stopped in this channel.",
    "classic.no_agent_here": "No active agent in this channel.",
    "admin.only": "⛔ Only admins can do this.",
    "admin.required": "⛔ This command requires admin access.",
    "not_authorized": "⛔ Not authorized",
    "usage.chat": "Usage: `/chat <message>`",
    "dashboard.title": "📊 AgEnD Dashboard",
    "update.available": "🆕 AgEnD {0} available! Run: agend update",
    "update.highlights": "Highlights: {0}",
    "restart.graceful": "🔄 Graceful restart — waiting for instances to idle...",
    "update.running": "📦 Updating AgEnD... Fleet will restart automatically.",
    "slash.start": "Start an agent in this channel",
    "slash.stop": "Stop the agent in this channel",
    "slash.chat": "Send a message to the agent",
    "slash.ctx": "Show context usage",
    "slash.cancel": "Interrupt the agent's current operation (sends Escape)",
    "slash.dashboard": "Get dashboard URLs (admin only)",
    "slash.compact": "Compact agent context window",
    "slash.save": "Save the agent's conversation",
    "slash.load": "Load a saved conversation",
    "slash.collab": "Toggle bot/webhook collaboration mode",
    "slash.status": "Show fleet status and costs",
    "slash.sysinfo": "System diagnostics",
    "slash.restart": "Graceful restart all instances",
    "slash.update": "Update AgEnD to latest version",
    "slash.doctor": "Run health diagnostics",
  },
  "zh-TW": {
    "cancel.button": "🛑 取消",
    "cancel.sent": "🛑 已送出取消給 {0}。",
    "cancel.not_running": "❌ {0} 未在執行。",
    "ctx.used": "📊 上下文：{0}% 已用",
    "ctx.backend": "後端：{0}",
    "ctx.instance": "實例：{0}",
    "ctx.unavailable": "上下文資訊尚未可用。",
    "classic.already_active": "此頻道已有活動中的 Agent。請用 /chat 對話。",
    "classic.topic_bound": "此頻道已綁定到 topic 模式的 instance。",
    "classic.not_authorized_guild": "⛔ 此伺服器不在允許清單中。",
    "classic.no_agent": "此頻道沒有活動中的 Agent。",
    "classic.no_agent_start": "此頻道沒有活動中的 Agent。請先用 /start。",
    "classic.started": "✅ Agent 已在此頻道啟動。用 `/chat <訊息>` 或 @mention 對話。",
    "classic.stopped": "🛑 已停止此頻道的 Agent。",
    "classic.no_agent_here": "此頻道沒有活動中的 Agent。",
    "admin.only": "⛔ 只有管理員能執行此操作。",
    "admin.required": "⛔ 此指令需要管理員權限。",
    "not_authorized": "⛔ 未授權",
    "usage.chat": "用法：`/chat <訊息>`",
    "dashboard.title": "📊 AgEnD 儀表板",
    "update.available": "🆕 AgEnD {0} 可更新！執行：agend update",
    "update.highlights": "更新重點：{0}",
    "restart.graceful": "🔄 優雅重啟中 — 等待 instances 閒置...",
    "update.running": "📦 正在更新 AgEnD... Fleet 會自動重啟。",
    "slash.start": "在此頻道啟動 Agent",
    "slash.stop": "停止此頻道的 Agent",
    "slash.chat": "傳送訊息給 Agent",
    "slash.ctx": "顯示上下文使用量",
    "slash.cancel": "中斷 Agent 目前的動作（送出 Escape）",
    "slash.dashboard": "取得儀表板網址（管理員）",
    "slash.compact": "壓縮 Agent 上下文",
    "slash.save": "儲存 Agent 對話",
    "slash.load": "載入已儲存的對話",
    "slash.collab": "切換 bot/webhook 協作模式",
    "slash.status": "顯示 Fleet 狀態與花費",
    "slash.sysinfo": "系統診斷",
    "slash.restart": "優雅重啟所有 instances",
    "slash.update": "更新 AgEnD 到最新版",
    "slash.doctor": "執行健康診斷",
  },
};

/** Translate a key with {0},{1},… positional args, using the active locale. */
export function t(key: string, ...args: (string | number)[]): string {
  const table = messages[current] ?? messages.en;
  const msg = table[key] ?? messages.en[key] ?? key;
  return msg.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""));
}
