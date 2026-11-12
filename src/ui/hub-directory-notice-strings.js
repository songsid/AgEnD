import { register, t } from "/assets/app-i18n.js";
register("directoryNotices", {
  en: {
    pageLead: "Security notices about your Hub sign-in and fleet connections.", title: "AD connection changes", lead: "Security notices about changes to Hub sign-in. A notice records a change, not whether the connection is healthy.",
    hostLead: "For this computer's owner. Your acknowledgment is separate from each Hub recipient's acknowledgment.",
    changed: "AD connection change recorded", restored: "AD connection restoration recorded", host: "Changed by the host owner", admin: "Changed by a Hub administrator",
    server: "Server", ca: "Certificate trust", search: "Search settings", "service-account": "Service account", secret: "Service password", query: "Directory query",
    acknowledge: "Acknowledge", acknowledged: "Acknowledged", acknowledging: "Acknowledging…", older: "Older notices", refresh: "Refresh", retry: "Retry",
    empty: "No AD connection notices", readOnly: "Reading a notice does not acknowledge it.", loading: "Loading AD connection notices…",
    busy: "The Hub is busy. Retrying shortly.", busyAck: "The Hub is busy. Try Acknowledge again shortly.",
    unavailable: "AD connection notices can't be checked right now. Try again.", auth: "Sign in again to read these notices.",
    denied: "This sign-in can't read these notices.", unsupported: "Reload this page after AgEnD has updated to read AD connection notices.",
    uncertain: "We couldn't confirm the acknowledgment. Refresh to check before trying again.",
  },
  "zh-TW": {
    pageLead: "Hub 登入與 Fleet 連接的安全通知。", title: "AD 連線變更", lead: "Hub 登入設定變更的安全通知。通知代表已記錄變更，不代表目前的網路連線正常。",
    hostLead: "供這台電腦的擁有者查看。你的確認與各 Hub 收件者的確認分開記錄。",
    changed: "已記錄 AD 連線變更", restored: "已記錄 AD 連線還原", host: "由主機擁有者變更", admin: "由 Hub 管理員變更",
    server: "伺服器", ca: "憑證信任", search: "搜尋設定", "service-account": "服務帳號", secret: "服務密碼", query: "目錄查詢",
    acknowledge: "確認已讀", acknowledged: "已確認", acknowledging: "確認中…", older: "較早的通知", refresh: "重新整理", retry: "重試",
    empty: "沒有 AD 連線通知", readOnly: "查看通知不會自動確認已讀。", loading: "正在載入 AD 連線通知…",
    busy: "Hub 忙碌中，稍後自動重試。", busyAck: "Hub 忙碌中，請稍後再按確認已讀。",
    unavailable: "目前無法查詢 AD 連線通知，請重試。", auth: "請重新登入後查看通知。",
    denied: "目前的登入無法查看這些通知。", unsupported: "AgEnD 更新後，請重新載入此頁以查看 AD 連線通知。",
    uncertain: "無法確認是否已記錄已讀。請先重新整理查看，再決定是否重試。",
  },
});
export const dn = key => t(`directoryNotices.${key}`);
