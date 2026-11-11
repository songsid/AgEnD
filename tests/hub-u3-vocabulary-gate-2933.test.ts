/**
 * Hub UX U3 (spec 1.4, A-L14): one vocabulary. Every string the listed UI modules register is read from the source
 * (tests/helpers/ui-dictionaries.ts — nothing executed, nothing skipped) and checked against the banned terms:
 *   zh: 配對, 連線, 公開, 組織帳號, 手動配對碼, 一次性配對碼, 同仁連線連結
 *   EN: pair, exposure, expose, organisation, "Hub admin", "one-time / manual pairing code"
 * Allowed: the legacy path's own name — 配對碼 / "pairing code(s)" (the 1.4 table), network-connection phrases (網路連線,
 * 目錄連線, 服務連線, 測試連線, 重新連線, 連線中斷, 離線), and 配對 / pair inside the pairing-code path's own keys, named below.
 */
import { describe, expect, it } from "vitest";
import { uiDictionaries, type UiString } from "./helpers/ui-dictionaries.js";

export const MODULES = ["hub-strings.js", "hub-company-join-strings.js", "hub-quick-strings.js", "hub-owner-strings.js", "hub-group-strings.js", "hub-chat-strings.js",
  "hub-grant-strings.js", "hub-pairing-progress-strings.js", "hub-read-strings.js", "settings-hub-setup-strings.js",
  "settings-hub-connection.js", "settings-hub-membership.js", "settings-hub-company-join.js",
  // U1 / U2's own dictionaries (written after the spec's list).
  "hub-join-one-strings.js", "hub-join-steps.js", "hub-group-search.js"].map((f) => `src/ui/${f}`);

/** The pairing-code path's own keys: 配對 / pair may appear here (and only the "pair" class of terms is excused). */
export const PAIRING_CODE_KEYS = new Set([
  "hub.pairingsTitle", "hub.pairTitle", "hub.pendingPairings", "hub.pairingFp",
  "hubQuick.ownerStep", "hubQuick.mismatchStop", "hubQuick.stop", "hubQuick.stopped", "hubQuick.unavailable", "hubQuick.limit", "hubQuick.expired",
  "hubOwner.pairSteps", "hubOwner.pendingPairings",
  "hubPairingProgress.connectFailed", "hubPairingProgress.notApplied", "hubPairingProgress.unknown",
]);
const ZH_NETWORK = /網路連線|目錄連線|服務連線|測試連線|重新連線|連線中斷|離線/g;
const ZH_ALWAYS = /手動配對碼|一次性配對碼|同仁連線連結|組織帳號|公開|連線/;
const EN_ALWAYS = /one-time pairing code|manual pairing code|\bexposures?\b|\bexpose[ds]?\b|organisation|\bHub admin\b(?!istrator)/i;

/** The banned terms in one string, as the gate sees them (empty: clean). */
export function offences(s: UiString): string[] {
  const pairOk = PAIRING_CODE_KEYS.has(`${s.ns}.${s.key}`);
  if (s.lang === "zh-TW") {
    const t = s.text.replace(ZH_NETWORK, ""), out: string[] = [];
    const always = t.match(new RegExp(ZH_ALWAYS.source, "g")) ?? []; out.push(...always);
    if (!pairOk && /配對(?!碼)/.test(t.replace(/手動配對碼|一次性配對碼/g, ""))) out.push("配對");
    return out;
  }
  if (s.lang === "en") {
    const out = (s.text.match(new RegExp(EN_ALWAYS.source, "gi")) ?? []).slice();
    const rest = s.text.replace(/(one-time |manual )?pairing codes?/gi, "");   // the legacy name (its banned forms were counted above)
    if (!pairOk && /\bpair(s|ed|ing)?\b/i.test(rest)) out.push("pair");
    return out;
  }
  return [];
}

describe("U3: one vocabulary across the Hub and Fleet Hub strings (A-L14)", () => {
  it.each(MODULES)("%s: every value is read, more than zero keys, no banned term outside the pairing-code path", (file) => {
    const d = uiDictionaries(file);
    expect(d.unread).toEqual([]);
    expect(d.strings.length).toBeGreaterThan(0);
    const bad = d.strings.flatMap((s) => offences(s).map((o) => `${s.ns}.${s.key} [${s.lang}] "${o}": ${s.text}`));
    expect(bad).toEqual([]);
  });
  it("the allow-list names only keys that exist (no stale entry hides nothing)", () => {
    const keys = new Set(MODULES.flatMap((f) => uiDictionaries(f).strings.map((s) => `${s.ns}.${s.key}`)));
    expect([...PAIRING_CODE_KEYS].filter((k) => !keys.has(k))).toEqual([]);
  });
  it("A-L14: the gate fires when a banned term is put back — each class once", () => {
    const s = (lang: string, text: string, key = "anything"): UiString => ({ file: "x", ns: "hub", lang, key, text });
    expect(offences(s("zh-TW", "我的公開 Agent"))).toEqual(["公開"]);
    expect(offences(s("zh-TW", "請使用組織帳號登入。"))).toEqual(["組織帳號"]);
    expect(offences(s("zh-TW", "已配對的 Fleet"))).toEqual(["配對"]);
    expect(offences(s("zh-TW", "連線到 Hub"))).toEqual(["連線"]);
    expect(offences(s("zh-TW", "請輸入手動配對碼"))).toEqual(["手動配對碼"]);
    expect(offences(s("zh-TW", "複製同仁連線連結"))).toEqual(["同仁連線連結"]);
    expect(offences(s("en", "My exposures"))).toEqual(["exposures"]);
    expect(offences(s("en", "Use your organisation account."))).toEqual(["organisation"]);
    expect(offences(s("en", "Contact your Hub admin."))).toEqual(["Hub admin"]);
    expect(offences(s("en", "Pair a fleet"))).toEqual(["pair"]);
    expect(offences(s("en", "One-time pairing code"))).toEqual(["One-time pairing code"]);
    // …and lets through what the table keeps
    expect(offences(s("zh-TW", "請輸入配對碼。暫時離線會自動重新連線。目錄連線失敗。"))).toEqual([]);
    expect(offences(s("en", "Ask them for a pairing code. Contact your Hub administrator."))).toEqual([]);
    expect(offences(s("en", "Pairing requests for you", "pairingsTitle"))).toEqual([]);             // the code path's own key
  });
});
