/**
 * M-2921 (Hub UX U1, spec 1.1 / 1.3): the words of the one-input Hub form, its probe line, messages E1–E14, the sign-in
 * wait and the connected / held card. A module of its own (not added to hub-company-join-strings.js), so a page whose
 * older company-join dictionary is cached still has every new word (upgrade skew).
 */
import { register, t } from "/assets/app-i18n.js";
export const joinOneStringsV1 = true;
register("joinOne", {
  en: {
    input: "Hub address", placeholder: "hub.example.com", go: "Sign in with company account", other: "Other ways",
    otherPairing: "This looks like a pairing code. Use it below.",
    found: "Found “{0}”. This Fleet will appear as “{1}”.", rename: "Rename", label: "Fleet name (optional)",
    probing: "Looking up the Hub…",
    E1: "That is not a Hub address. Enter one like hub.example.com.",
    E2: "A Hub address must use https.",
    E3: "{0} cannot be reached. Check the address and that this computer is on the company network.",
    E4: "This computer does not trust {0}'s certificate, so nothing was connected. Check the address or certificate with your Hub administrator.",
    E5: "{0} is not an AgEnD Hub.",
    E6: "“{0}” does not accept company-account connections yet. Ask its administrator to turn them on.",
    E7: "The Hub and this Fleet need different host names. A different port is not enough.",
    E8: "“{0}” presents a different identity than before, so nothing was connected. Confirm with your Hub administrator, then choose Replace saved Hub identity.",
    E9: "Your company account may not connect a Fleet. Ask your Hub administrator.",
    E10: "You have reached the limit of connected Fleets. Revoke one on the Hub first.",
    E11: "The Hub is handling other connections and will retry shortly.",
    E12: "This attempt timed out and nothing was created. Press again.",
    E13: "Another connection with a pairing code is still in progress for you. Finish or stop it on the Hub first.",
    E14: "The result could not be confirmed. Choose Check this connection; do not start again.",
    limited: "Too many lookups. Wait a minute, then try again.",
    opened: "Opened the sign-in tab for {0}…", left: "{0} left", reopen: "Reopen tab", cancel: "Cancel",
    ownerLine: "Connected with {0}'s company account · This Fleet is called “{1}”",
    reconnect: "Reconnect", remove: "Remove this connection",
    removeAsk: "Remove the connection to “{0}”? Agents you share will stop answering.", removeYes: "Remove", removeNo: "Keep",
    removed: "The connection was removed.",
  },
  "zh-TW": {
    input: "Hub 位址", placeholder: "hub.example.com", go: "以公司帳號登入", other: "其他方式",
    otherPairing: "這看起來是配對碼，請在下方使用。",
    found: "找到「{0}」。這台 Fleet 會顯示為「{1}」", rename: "改名", label: "Fleet 名稱（選填）",
    probing: "正在查詢 Hub…",
    E1: "這不是 Hub 位址。請輸入像 hub.example.com 的位址。",
    E2: "Hub 位址必須是 https。",
    E3: "連不上 {0}。請確認位址，以及這台電腦連得到公司網路。",
    E4: "{0} 的憑證不受這台電腦信任，所以沒有連接。請向 Hub 管理員確認位址或憑證。",
    E5: "{0} 不是 AgEnD Hub。",
    E6: "「{0}」還沒開放用公司帳號連接。請 Hub 管理員開啟。",
    E7: "Hub 和這台 Fleet 的網址要用不同的主機名稱。只換連接埠不行。",
    E8: "「{0}」的身分和上次不同，所以沒有連接。請向 Hub 管理員確認後，再選「更換已儲存的 Hub 身分」。",
    E9: "你的公司帳號沒有連接 Fleet 的權限。請找 Hub 管理員。",
    E10: "你連接的 Fleet 已達上限。請先在 Hub 撤銷一台。",
    E11: "Hub 正在處理其他連接，稍後會自動再試。",
    E12: "這次連接逾時了，沒有建立任何東西。請再按一次。",
    E13: "你有另一個用配對碼的連接還沒完成。請先在 Hub 完成或停止它。",
    E14: "無法確認結果。請按「檢查這次連接」，不要重新開始。",
    limited: "查詢太多次了。請等一分鐘再試。",
    opened: "已開啟 {0} 的登入分頁…", left: "剩 {0}", reopen: "重新開啟分頁", cancel: "取消",
    ownerLine: "以 {0} 的公司帳號連接 · 這台 Fleet 叫「{1}」",
    reconnect: "重新連接", remove: "移除這個連接",
    removeAsk: "要移除與「{0}」的連接嗎？你分享的 Agent 會停止回答。", removeYes: "移除", removeNo: "保留",
    removed: "已移除連接。",
  },
});
export const j1 = (key, ...args) => t(`joinOne.${key}`, ...args);

const HOST = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6 = /^\[[0-9A-Fa-f:.]+\]$/;
const CODE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{4}-?[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{4}$/;
const PAIRING = /^[0-9A-Fa-f]{12}$|^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/;
function hostPort(value) {
  const at = value.startsWith("[") ? value.indexOf("]") + 1 : value.lastIndexOf(":") >= 0 ? value.lastIndexOf(":") : value.length;
  const host = value.slice(0, at || value.length), rest = value.slice(at);
  if (rest && !/^:\d{1,5}$/.test(rest)) return false;
  if (rest && Number(rest.slice(1)) > 65535) return false;
  return HOST.test(host) || IPV6.test(host);
}
function address(value) {
  if (/^http:\/\//i.test(value)) return { error: "E2" };
  if (/^https:\/\//i.test(value)) {
    try { const u = new URL(value); if (u.protocol !== "https:" || u.username || u.password) return { error: "E1" };
      // A legacy company link or invitation: sent unchanged; a bare web address: its origin.
      if (u.hash) return u.pathname === "/join-info" && /^#(hub|invite)=/.test(u.hash) ? { address: value } : { error: "E1" };
      return u.pathname === "/" && !u.search ? { address: u.origin } : { error: "E1" };
    } catch { return { error: "E1" }; }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return { error: "E1" };
  return hostPort(value) ? { address: "https://" + value.toLowerCase() } : { error: "E1" };
}
/**
 * Spec 1.1: what the one input holds, in the spec's order — a link or address (with an optional Phase B code after
 * whitespace), a pairing code (12 hex, alone or after an address: never sent; it opens 其他方式), http (E2), else E1.
 */
export function classifyHubInput(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { kind: "empty" };
  const parts = value.split(/\s+/);
  if (parts.length === 1 && PAIRING.test(parts[0])) return { kind: "pairing", code: parts[0] };
  if (parts.length > 2) return { kind: "error", error: "E1" };
  const first = address(parts[0]);
  if (parts.length === 2) {
    if (first.error) return { kind: "error", error: first.error };
    if (PAIRING.test(parts[1])) return { kind: "pairing", address: first.address, code: parts[1] };
    if (CODE.test(parts[1])) return { kind: "address", address: first.address, code: parts[1].toUpperCase() };
    return { kind: "error", error: "E1" };
  }
  return first.error ? { kind: "error", error: first.error } : { kind: "address", address: first.address };
}
/** E3–E8 from a probe answer, or null when the Hub can be joined. */
export function probeMessage(p, host) {
  if (!p) return null;
  if (p.ok === false) return p.reason === "certificate" ? j1("E4", host) : p.reason === "not-hub" ? j1("E5", host) : p.reason === "limited" ? j1("limited") : j1("E3", host);
  const name = p.hubName || host;
  if (!p.companyJoin) return j1("E6", name);
  if (!p.separateHosts) return j1("E7");
  if (p.identity === "changed") return j1("E8", name);
  return null;
}
/** S1's nonterminal refusals of a pending request (status.waiting): E13 / E10 / E9 / E11. */
export function waitingMessage(waiting) {
  return waiting === "offer-pending" ? j1("E13") : waiting === "limit-reached" ? j1("E10") : waiting === "denied" ? j1("E9") : waiting === "backpressure" ? j1("E11") : null;
}
/** A held or ended operation's reason, in the spec's words where it has them (else null: the existing wording). */
export function reasonMessage(view) {
  const r = view?.reason;
  if (r === "expired" && !view.issued) return j1("E12");
  return r === "denied" ? j1("E9") : r === "limit-reached" ? j1("E10") : r === "backpressure" ? j1("E11") : r === "offer-pending" ? j1("E13")
    : r === "unknown" || r === "uncertain" ? j1("E14") : r === "separate-hostnames" ? j1("E7") : null;
}
/** mm:ss left until `deadline` (epoch ms). */
export function leftOf(deadline, now = Date.now()) {
  const s = Math.max(0, Math.ceil((deadline - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
