// M-2988 (Lumen's Hub story board, round 2, finding 1): a colleague holding the administrator's join code fills the
// Fleet's one Hub input. Words for it: a hint that the code goes after the address with a space, a code typed on its
// own, and "join code included" once it is recognised. The administrator's copied text — "In AgEnD Settings → Hub, enter
// {host} and this code." with the code on the next line (hub-enrolment-code.js) — is read as the address and the code,
// in either language, also after a text field has dropped its line break. Its own module and namespace, so a tab that still
// holds an older hub-join-one-strings.js loads this panel (a missing named export would stop the module from loading).
import { register, t } from "/assets/app-i18n.js";
import { classifyHubInput } from "./hub-join-one-strings.js";

register("joinCode", {
  en: {
    hint: "Enter the Hub address, or paste what your Hub administrator sent you. A join code goes after the address with a space: hub.example.com ABCD-EFGH",
    codeOnly: "That is a join code. Put the Hub address before it, with a space: hub.example.com {0}",
    included: "Join code included.",
    // alpha.2 rehearsal findings 3/4: a refused or held attempt, and one another browser session started.
    codeDenied: "The Hub did not accept this join code: it may have ended or been mistyped, or your account may not be allowed to connect a Fleet. Ask your Hub administrator for a current code, then start again.",
    blocked: "Another connection attempt is still open (shown above). Use “Recover this connection” or “Cancel connection” on it, then start again.",
    foreignHeld: "This attempt was started in another browser tab or session. You can recover or cancel it here.",
    foreignBusy: "This attempt is still in progress in another browser tab or session. Finish it there, or wait for it to end ({0} left).",
  },
  "zh-TW": {
    hint: "輸入 Hub 位址，或貼上 Hub 管理員給你的內容。加入碼接在位址後面、中間空一格：hub.example.com ABCD-EFGH",
    codeOnly: "這是加入碼。請在前面加上 Hub 位址，中間空一格：hub.example.com {0}",
    included: "已帶入加入碼。",
    codeDenied: "Hub 沒有接受這組加入碼：可能已停用或打錯，也可能你的帳號不能連接 Fleet。請向 Hub 管理員要一組有效的加入碼，再重新開始。",
    blocked: "還有一個連接嘗試沒有結束（顯示在上方）。請先按「恢復這次連接」或「取消連接」，再重新開始。",
    foreignHeld: "這個連接嘗試是在另一個瀏覽器分頁或工作階段開始的。你可以在這裡恢復或取消它。",
    foreignBusy: "這個連接嘗試還在另一個瀏覽器分頁或工作階段進行中。請在那裡完成，或等它結束（剩 {0}）。",
  },
});
export const jc = (key, ...args) => t(`joinCode.${key}`, ...args);

const CODE_CHARS = "0-9A-HJKMNP-TV-Za-hjkmnp-tv-z";
const CODE_DASHED = new RegExp(`^[${CODE_CHARS}]{4}-[${CODE_CHARS}]{4}$`);
const TRAILING_CODE = new RegExp(`(?:^|[\\s.。:：,，])([${CODE_CHARS}]{4}-[${CODE_CHARS}]{4})$`);
const QUOTES = /^[「『“"'(（\[]+|[」』”"'),，。.、:：;；!！?？\])]+$/g;

/**
 * The administrator's handoff text, if that is what this is: one address (a word that reads as a Hub address with a dot,
 * a port or https://) and one dashed join code at the end. Returns "host CODE" for the input, or null.
 */
export function fromHandoffText(raw) {
  const text = String(raw ?? "").trim();
  const code = TRAILING_CODE.exec(text);
  if (!code) return null;
  const before = text.slice(0, text.length - code[1].length);
  if (!/\s/.test(before.trim()) && !/[\r\n]/.test(text)) return null;    // "host CODE" alone is the normal form, not a handoff
  const found = new Set();
  for (const word of before.split(/\s+/)) {
    const w = word.replace(QUOTES, "");
    if (!w || !(/^https:\/\//i.test(w) || /[.:]/.test(w) || w.startsWith("["))) continue;
    const k = classifyHubInput(w);
    if (k.kind === "address" && !k.code) found.add(k.address);
  }
  if (found.size !== 1) return null;
  const address = [...found][0], host = (() => { try { return new URL(address).host; } catch { return ""; } })();
  return host ? `${host} ${code[1].toUpperCase()}` : null;
}

/** classifyHubInput, plus: the handoff text (read as address + code) and a dashed join code typed alone (its own message). */
export function classifyJoinInput(raw) {
  const value = String(raw ?? "").trim();
  if (CODE_DASHED.test(value)) return { kind: "error", error: "codeOnly", code: value.toUpperCase() };
  const handoff = fromHandoffText(value);
  return classifyHubInput(handoff ?? value);
}
