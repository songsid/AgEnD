import type { Locale } from "./locale.js";

/** Passive General notice, posted by the installer after commit; never an input to the General agent. */
export function requestContextEnabledNotice(locale: Locale): string {
  return locale === "zh-TW"
    ? "依請求核准聯絡已開啟：核准只對這一次請求有效，先前的對話不會再擋住管理員的新請求。開關在「設定」→「存取與安全」。注意：已不能再降回舊版 AgEnD。"
    : "Request-based contact approvals are on: approval applies only to this request. Earlier conversations won't block an administrator's new request. The switch is in Settings → Access & security. Warning: you can no longer downgrade to older AgEnD versions.";
}
