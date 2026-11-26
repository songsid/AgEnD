import type { Locale } from "./locale.js";

/** Passive General notice, posted by the installer after commit; never an input to the General agent. */
export function requestContextEnabledNotice(locale: Locale): string {
  return locale === "zh-TW"
    ? "聯絡核准現在只跟著這次請求。先前的對話不會再擋住管理員的新請求。開關在「設定」→「存取與安全」→「依請求核准聯絡」。即使關閉，舊版也無法再開啟這個機群的資料。"
    : "Contact approvals now follow each request. Earlier conversations won't block an administrator's new request. The switch is in Settings → Access & security → Request-based contact approvals. Older versions cannot open this Fleet's data, even after you turn it off.";
}
