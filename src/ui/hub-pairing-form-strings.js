// #3840: the pairing-code form under "Other ways" (Settings → Hub). A pairing code is 12 hex characters (the server's
// own rule: lowercased, spaces and dashes removed, /^[a-f0-9]{12}$/ in src/hub/member/pairing-api.ts); it is checked here,
// on the page, before any confirmation is asked. A join code (XXXX-XXXX, for the Hub address box above) is recognised and
// pointed up. The form's address is the member address shown with the pairing code, not the Hub's page address. After a
// confirmed change fails, the handler's own reason is named. Its own module, so a page holding an older hub-strings
// dictionary still has every word (upgrade skew).
import { register, t } from "/assets/app-i18n.js";

register("hubPairingForm", {
  en: {
    addressHint: "The address shown with the pairing code (it ends in a port). It is not the address of the Hub's pages.",
    joinCode: "This is a join code. In “Hub address” at the top of this card, type the address, a space, then this code.",
    codeShape: "A pairing code is 12 characters, 0–9 and a–f (for example 1a2b3c4d5e6f).",
    failed_code: "Confirmed, but it was not applied: that is not a valid pairing code. A pairing code is 12 characters, 0–9 and a–f.",
    failed_address: "Confirmed, but it was not applied: that is not a Hub's member address.",
    failed_unreachable: "Confirmed, but it was not applied: the Hub could not be reached at that address.",
    failed_refused: "Confirmed, but it was not applied: the Hub refused this pairing code (used, expired or not issued for this Hub).",
    failed_busy: "Confirmed, but it was not applied: the Hub is busy. Try again in a moment.",
  },
  "zh-TW": {
    addressHint: "配對碼一起提供的位址（結尾有連接埠），不是 Hub 網頁的位址。",
    joinCode: "這是加入碼。請在這張卡片最上方的「Hub 位址」輸入位址、空一格，再輸入這組碼。",
    codeShape: "配對碼是 12 個字元，只有 0–9 與 a–f（例如 1a2b3c4d5e6f）。",
    failed_code: "已確認，但沒有套用：這不是有效的配對碼。配對碼是 12 個字元，只有 0–9 與 a–f。",
    failed_address: "已確認，但沒有套用：這不是 Hub 的成員位址。",
    failed_unreachable: "已確認，但沒有套用：連不到這個位址上的 Hub。",
    failed_refused: "已確認，但沒有套用：Hub 拒絕了這組配對碼（已使用、已過期，或不是這個 Hub 發的）。",
    failed_busy: "已確認，但沒有套用：Hub 目前忙碌，請稍後再試。",
  },
});
export const hpf = (key, ...args) => t(`hubPairingForm.${key}`, ...args);

const JOIN_CODE = /^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/i;
/** The pairing code as the server reads it: lowercased, spaces and dashes removed. */
export const pairingCodeNormal = (raw) => String(raw ?? "").trim().toLowerCase().replace(/[\s-]/g, "");
/** "ok" (12 hex), "join" (a join code, which belongs in the Hub address box), "shape" (anything else typed), or "" (empty). */
export function pairingCodeState(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  if (/^[a-f0-9]{12}$/.test(pairingCodeNormal(text))) return "ok";
  return JOIN_CODE.test(text) ? "join" : "shape";
}
/** The specific words for a confirmed connect that failed, from the replay's own reason ("apply_rejected: <error>"), or null. */
export function pairingFailure(outcome) {
  const m = /^apply_rejected: ([a-z_]+)$/.exec(String(outcome?.detail ?? ""));
  const key = m && ["code", "address", "unreachable", "refused", "busy"].includes(m[1]) ? `failed_${m[1]}` : null;
  return key ? hpf(key) : null;
}
