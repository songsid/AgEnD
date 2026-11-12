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
import { ALL, MODULES, PAIRING_CODE_KEYS, SHARED, offences } from "./helpers/hub-vocabulary.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairingSummary } from "../src/hub-pairing-summary.js";

describe("U3: one vocabulary across the Hub and Fleet Hub strings (A-L14)", () => {
  it.each(ALL)("%s: every value is read, no banned term outside the pairing-code path (the spec's modules: more than zero keys)", (file) => {
    const d = uiDictionaries(file);
    expect(d.unread).toEqual([]);
    if (MODULES.includes(file)) expect(d.strings.length).toBeGreaterThan(0);
    const bad = d.strings.flatMap((s) => offences(s).map((o) => `${s.ns}.${s.key} [${s.lang}] "${o}": ${s.text}`));
    expect(bad).toEqual([]);
  });
  it.each(SHARED)("$file: its Hub keys (the Settings confirmation of a Hub change, the access overview's Hub row) — none skipped, no banned term", ({ file, hub }) => {
    const d = uiDictionaries(file);
    expect(d.unread).toEqual([]);
    const mine = d.strings.filter(hub);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.flatMap((s) => offences(s).map((o) => `${s.ns}.${s.key} [${s.lang}] "${o}": ${s.text}`))).toEqual([]);
  });
  it("the server's own English copy of those confirmation lines (hub-pairing-summary.ts) follows the same words", () => {
    const hub = { hubId: "h1", memberOrigin: "https://a.test", webOrigin: "https://w.test", fingerprint: { kind: "hub-key", digest: "f".repeat(64) } };
    const lines = [
      ...pairingSummary("connect", { address: "https://a.test", code: "abcdef012345" }, { state: "unpaired" } as never).summary.map((t) => ["hub.pairing.summary.connect", t]),
      ...pairingSummary("disconnect", { hubId: "h1", binding: "b".repeat(64) }, { state: "paired", hub, link: "online" } as never, { hubId: "h1", binding: "b".repeat(64) }).summary.map((t) => ["hub.pairing.summary.disconnect", t]),
    ];
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.flatMap(([key, t]) => offences({ file: "src/hub-pairing-summary.ts", ns: "pendingSummary", lang: "en", key, text: t }).map((o) => `${o}: ${t}`))).toEqual([]);
  });
  it("#3700 r1: a dictionary the reader cannot read is reported, never skipped — each shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "u3-dict-")), f = join(dir, "x.js");
    try {
      writeFileSync(f, [
        'const NS = "n", words = {}, extra = {}, name = "x";',
        'register(NS, { en: { a: "fine" } });',                       // a namespace that is not a literal
        'register("n2", words);',                                     // a dictionary that is not an object literal
        'register("n3", { ...extra, en: { a: "fine" } });',           // a spread language entry
        'register("n4", { en: { a: name, ...extra, b: `x${name}` } });', // an identifier, a spread, a template with a value
      ].join("\n"));
      const d = uiDictionaries(f);
      expect(d.unread).toEqual([
        `${f}: register() with a namespace that is not a literal string`,
        `${f}: n2: register() with a dictionary that is not an object literal`,
        `${f}: n3: a language entry that is not an object`,
        `${f}: n4.en.a`, `${f}: n4.en.?`, `${f}: n4.en.b`,
      ]);
      expect(d.strings.map((s) => `${s.ns}.${s.lang}.${s.key}`)).toEqual(["n3.en.a"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("the allow-list names only keys that exist (no stale entry hides nothing)", () => {
    const keys = new Set([...ALL, ...SHARED.map((x) => x.file)].flatMap((f) => uiDictionaries(f).strings.map((s) => `${s.ns}.${s.key}`)));
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
    expect(offences(s("zh-TW", "請輸入配對碼。暫時離線會自動重新連線。目錄連線失敗。公開連結上沒有。"))).toEqual([]);
    expect(offences(s("en", "Ask them for a pairing code. Contact your Hub administrator."))).toEqual([]);
    expect(offences(s("en", "Pairing requests for you", "pairingsTitle"))).toEqual([]);             // the code path's own key
  });
});
