// #2726: what the setup host and the wizard's routes answer with — English words, or a code — in English and 繁體中文.
// One table for every page that shows them: the setup pages (src/setup-i18n.ts pastes this module into them, before any
// fleet, with its `export`s taken out) and the dashboard's Setup wizard and Apply (/assets/setup-host-text.js). Plain
// script with no imports and no closing script tag, so it can be pasted as it is.

/**
 * The host's English words → 繁體中文. `{0}`, `{1}` are the parts that vary (a name, a count). Kept to the exact wording
 * of the host (setup-host.ts, quickstart-api.ts, token-env-name.ts, the provider probes); tests/setup-i18n-2726.test.ts
 * drives each source and checks it is here.
 */
export const HOST_MESSAGES = [
  // The code page (setup-host.ts redeem / afterFailure / the cookie gate).
  ["incorrect — {0} attempts left", "代碼不正確 —— 還可以再試 {0} 次"],
  ["incorrect — {0} attempt left", "代碼不正確 —— 還可以再試 {0} 次"],
  ["too many failed attempts — run `agend setup` again on the host", "錯誤次數太多 —— 請在主機上再執行一次 `agend setup`"],
  ["enter the setup code", "請輸入設定代碼"],
  ["enter the setup code first", "請先輸入設定代碼"],
  ["cross-site request rejected", "已拒絕跨站請求"],
  ["not found", "找不到"],
  // Finishing (setup-host.ts finishSetup / status).
  ["Setup changed; review and confirm again.", "設定已改變；請重新檢查並再確認一次。"],
  ["Setup confirmation unavailable.", "無法取得設定確認。"],
  // The wizard's validation (quickstart-api.ts validateWizardInput, validateWebOnlyInput).
  ["working_directory must be an absolute path, or empty for the agent's own workspace", "工作目錄必須是絕對路徑，或留空讓 agent 使用自己的資料夾"],
  ["instance_name must be [A-Za-z0-9._-], and not only dots", "agent 名稱只能用英文字母、數字和 . _ -，而且不能只有句點"],
  ["backend must be a known backend", "請選擇一個支援的後端"],
  ["{0} does not apply to a web-only setup", "只用網頁的設定不使用 {0}"],
  ["platform must be telegram or discord", "平台必須是 Telegram 或 Discord"],
  ["token_env must be an UPPER_SNAKE env var name", "環境變數名稱只能用大寫英文字母、數字和底線（例如 AGEND_BOT_TOKEN）"],
  // A specific wording before the general one it would also match (the first that matches is used).
  ["guild id must be numeric", "伺服器 id 必須是數字"],
  ["{0} must be numeric", "{0} 必須是數字"],
  ["Your Discord user ID is required: enter 17–20 digits, without a leading zero.", "Discord 使用者 ID 必填：請輸入 17–20 位數字，開頭不能是 0。"],
  ["Your Telegram user ID is required: enter 1–20 positive digits, without a leading zero.", "Telegram 使用者 ID 必填：請輸入 1–20 位正整數字，開頭不能是 0。"],
  // Conflicts (agentConflict, newConnectionConflict, webOnlyConflict, token-env-name.ts).
  ["an agent called \"{0}\" already exists — connect it as an existing agent, or choose another name", "已經有名為「{0}」的 agent —— 請把它當作既有的 agent 連接，或換一個名稱"],
  ["there is no agent called \"{0}\"", "沒有名為「{0}」的 agent"],
  ["the General agent works in its own folder — leave the working directory empty to make \"{0}\" the General, or choose another name", "General agent 使用自己的資料夾 —— 若要讓「{0}」成為 General，請把工作目錄留空，或換一個名稱"],
  ["the name \"{0}\" is kept for the fleet's General agent — choose another name", "「{0}」這個名稱保留給 fleet 的 General agent —— 請換一個名稱"],
  ["a connection called \"{0}\" already exists — a new connection never replaces one", "已經有名為「{0}」的連線 —— 新的連線不會取代既有的連線"],
  ["this fleet already has a chat connection — add the agent with New agent instead", "這個 fleet 已經有聊天連線 —— 請改用「新增 Agent」加入 agent"],
  ["{0} is reserved", "{0} 是保留名稱"],
  ["{0} already holds the token of the \"{1}\" connection — a new connection never replaces one; use Replace token on that connection", "{0} 已經存著「{1}」連線的 token —— 新的連線不會取代它；請在那個連線上用「更換 token」"],
  ["{0} is no longer free (it was taken after this setup was planned) — plan it again", "{0} 已被使用（在這次設定規劃之後）—— 請重新產生一次"],
  ["the data dir's .env cannot be read: {0}", "無法讀取資料目錄的 .env：{0}"],
  // Requests and writes (quickstart-api.ts handlers).
  ["token required", "請輸入 bot token"],
  ["invalid JSON", "請求內容不是有效的 JSON"],
  ["bad request", "請求無效"],
  ["unknown probe", "不支援的檢查"],
  ["fleet not loaded", "設定尚未載入"],
  ["another secret operation is still running", "另一個寫入 token 的操作還在進行中"],
  ["setup cleanup failed; inspect configuration on the host", "設定的復原失敗；請在主機上檢查設定"],
  ["setup was not committed", "設定沒有寫入"],
  ["Token verification is not permitted over a public link", "公開連結不能驗證 token"],
  ["This bot token is already being polled by the running fleet. Enter the group id by hand, or stop AgEnD first.", "執行中的 fleet 正在使用這個 bot token。請手動輸入群組 id，或先停止 AgEnD。"],
  ["Another process is already reading this bot's updates. Stop it, or enter the group id by hand.", "另一個程式正在讀取這個 bot 的訊息。請停止它，或手動輸入群組 id。"],
  ["Discord replied {0}", "Discord 回應 {0}"],
  ["Telegram replied {0}", "Telegram 回應 {0}"],
  // The plan's warning (quickstart-api.ts planQuickstart and the web-only plan).
  ["{0} was not found on this host; the agent will fail to start until it is installed.", "這台主機上找不到 {0}；安裝之前，agent 會無法啟動。"],
];

/** What the host answers with a code instead of words (the confirmation gate, settings-effect.ts; the finish step). */
export const HOST_CODES = {
  en: {
    invalid_quickstart: "This setup is not valid. Review it and try again.",
    connection_exists: "That connection already exists — a new connection never replaces one.",
    agent_conflict: "That agent name is taken, or that agent does not exist.",
    too_many_pending_changes: "Too many changes are waiting for confirmation. Deal with them on the host first.",
    idempotency_key_reused: "This request was already sent with different content. Review it and send it again.",
    settings_confirmation_unavailable: "Host confirmation is not available right now. Try again shortly.",
    session_required: "This setup session has ended. Reopen setup on the host.",
    invalid_json: "The request was not valid JSON.",
    invalid_settings_body: "The request was not valid.",
    signin_cleanup_failed: "The login process could not be confirmed closed. Close it on the host and restart setup before retrying.",
  },
  "zh-TW": {
    invalid_quickstart: "這份設定無效。請檢查後再試一次。",
    connection_exists: "這個連線已存在 —— 新的連線不會取代既有的連線。",
    agent_conflict: "這個 agent 名稱已被使用，或那個 agent 不存在。",
    too_many_pending_changes: "等待確認的變更太多。請先在主機上處理它們。",
    idempotency_key_reused: "這個請求已經用不同的內容送出過。請重新檢查後再送出。",
    settings_confirmation_unavailable: "目前無法要求主機確認。請稍後再試。",
    session_required: "這個設定工作階段已結束。請在主機上重新開啟設定。",
    invalid_json: "請求內容不是有效的 JSON。",
    invalid_settings_body: "請求無效。",
    signin_cleanup_failed: "無法確認登入程序已關閉。請在主機上關閉它，並重新開始設定後再試。",
  },
};

const patterns = HOST_MESSAGES.map(([en, zh]) => ({
  zh, holes: [...en.matchAll(/\{(\d)\}/g)].map((m) => m[1]),
  pattern: new RegExp("^" + en.split(/\{\d\}/).map((part) => part.replace(/[.*+?^$|()[\]{}\\]/g, "\\$&")).join("(.+?)") + "$"),
}));

/** The host's words, or its code, in `lang` ("en" | "zh-TW"); anything it does not know stays as it came. */
export function hostText(text, lang) {
  if (typeof text !== "string") return text;
  if (Object.hasOwn(HOST_CODES.en, text)) return (HOST_CODES[lang] || HOST_CODES.en)[text];
  if (lang !== "zh-TW") return text;
  for (const { zh, holes, pattern } of patterns) {
    const found = pattern.exec(text);
    if (found) { let out = zh; holes.forEach((hole, i) => { out = out.split("{" + hole + "}").join(found[i + 1]); }); return out; }
  }
  return text;
}
