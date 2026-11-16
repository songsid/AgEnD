/**
 * M-3251 (the user): the sign-in page's 「如何在手機開啟 AgEnD？」 listed the same Wi-Fi (the computer's LAN address) first,
 * a private network, then an address the admin provides. The dashboard answers on 127.0.0.1 only, so the LAN line was
 * wrong. Now, easiest first: 1. the temporary link /web opens (🌐 Other device), 2. a fixed link (a fixed public hostname
 * in Settings → Access & security), 3. a private network such as Tailscale. A fleet with no chat (web-only, or its chat not
 * connected) gets its own: Allow connections from outside (the authenticator), the fixed link, then a private network
 * with a code from `agend web --code`. The page's own script (src/ui/shared/signin.js) in a vm, on the page's own HTML;
 * a browser is the PR's smoke.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

const SRC = readFileSync(join(process.cwd(), "src", "ui", "shared", "signin.js"), "utf8");
const HTML = readFileSync(join(process.cwd(), "src", "ui", "signin.html"), "utf8");
const IDS = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
/** An older page (cached before this change): three items, Wi-Fi / private / outside. */
const OLD_IDS = new Set([...[...IDS].filter((id) => !["reachTemp", "reachFixed"].includes(id)), "reachWifi", "reachOutside"]);

type Node = { id: string; hidden: boolean; parts: Array<string | { code: string }>; text(): string };
async function load(o: { lang?: string; hostname?: string; marks?: Record<string, string>; ids?: Set<string> } = {}) {
  const nodes = new Map<string, Node>();
  const ids = o.ids ?? IDS;
  const node = (id: string): any => {
    if (!ids.has(id)) return null;
    if (!nodes.has(id)) {
      const n: any = { id, hidden: id === "reachHelp" || id !== "checking", parts: [] as Node["parts"],
        text() { return n.parts.map((p: any) => (typeof p === "string" ? p : p.code)).join(""); },
        get textContent() { return n.text(); }, set textContent(v: string) { n.parts = [v]; },
        replaceChildren(...kids: any[]) { n.parts = kids.map((k) => (typeof k === "string" ? k : k.tag === "code" ? { code: k.textContent } : k.textContent)); },
        classList: { add() {}, remove() {} }, addEventListener() {}, focus() {}, select() {}, setAttribute() {}, removeAttribute() {}, value: "", disabled: false };
      nodes.set(id, n);
    }
    return nodes.get(id);
  };
  const hostname = o.hostname ?? "agend.example.com";
  const location = { href: `https://${hostname}/signin`, hostname, pathname: "/signin", search: "", hash: "", origin: `https://${hostname}`, replace() {} };
  const context = createContext({
    document: { documentElement: {}, getElementById: node, querySelectorAll: () => [], body: { getAttribute: (k: string) => o.marks?.[k] ?? null },
      createElement: (tag: string) => ({ tag, textContent: "", className: "" }) },
    location, history: { replaceState() {} }, navigator: { language: o.lang ?? "en", userAgent: "Mozilla/5.0 (iPhone)" },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url: string) => (url === "/auth/device" ? { ok: true, status: 200, json: async () => ({ returning: false }) } : { ok: false, status: 401 }),
    URL, URLSearchParams, JSON, Date, Number, String, setTimeout, clearTimeout,
  });
  runInContext(SRC, context);
  for (let n = 0; n < 30; n++) await new Promise((r) => setImmediate(r));
  const get = (id: string) => nodes.get(id);
  return { get, items: (list: string[]) => list.map((id) => get(id)?.text() ?? null) };
}
const NEW = ["reachTemp", "reachFixed", "reachPrivate"];

describe("M-3251: how a phone opens AgEnD, easiest first", () => {
  it("the page: one ordered list, the temporary link, the fixed link, a private network", () => {
    expect(HTML).toMatch(/<details id="reachHelp"[^>]*>.*<ol><li id="reachTemp"><\/li><li id="reachFixed"><\/li><li id="reachPrivate"><\/li><\/ol><\/details>/);
    expect(HTML).not.toMatch(/reachWifi|reachOutside/);
    // The dashboard answers on 127.0.0.1 only: no line tells a phone to use the computer's local network address.
    expect(SRC).not.toMatch(/"[^"\n]*(Wi-Fi|local network address|區網)[^"\n]*"/);   // in no string the page shows (its comments may name them)
  });

  it("a chat fleet (en): /web's 🌐 link, a fixed hostname in Settings, then Tailscale with a code from /web", async () => {
    const p = await load();
    expect(p.get("reachHelp")?.hidden).toBe(false);
    expect([p.get("reachTitle")?.text(), p.get("reachLead")?.text()]).toEqual(["How do I open AgEnD on my phone?", "Easiest first:"]);
    expect(p.items(NEW)).toEqual([
      "Temporary link: send /web in General and choose 🌐 Other device. The link and a sign-in code come to you privately.",
      "Fixed link: set a fixed public hostname in Settings → Access & security. /web then opens the same address every time, so it can stay on your home screen.",
      "Private network, such as Tailscale: share the dashboard on it from the AgEnD computer, open that address on your phone, and sign in with a code from /web. On its own, the dashboard answers only on the AgEnD computer.",
    ]);
  });

  it("a chat fleet (zh-TW): 臨時連結 → 固定連結 → 私人網路", async () => {
    const p = await load({ lang: "zh-TW" });
    expect([p.get("reachTitle")?.text(), p.get("reachLead")?.text()]).toEqual(["如何在手機開啟 AgEnD？", "由簡單到進階："]);
    const [temp, fixed, priv] = p.items(NEW) as string[];
    expect(temp).toBe("臨時連結：在 General 傳 /web，選「🌐 其他裝置登入」。連結和裝置登入碼會私訊給你。");
    expect(fixed).toMatch(/^固定連結：在「設定 → 存取與安全」填好固定公開網域。/);
    expect(priv).toMatch(/^私人網路（如 Tailscale）：.*\/web 取得的裝置登入碼登入。儀表板本身只在 AgEnD 電腦上回應。$/);
  });

  for (const [what, marks] of [["a web-only fleet", { "data-web-only": "1" }], ["a chat fleet whose chat is not connected", { "data-no-chat": "1" }]] as const) {
    it(`${what}: never /web — Allow connections from outside, the fixed link, then a private network with agend web --code`, async () => {
      for (const lang of ["en", "zh-TW"]) {
        const p = await load({ lang, marks });
        const items = p.items(NEW) as string[];
        expect(items.every((s) => s && !s.includes("/web ") && !s.includes("/web，") && !s.includes("/web。")), `${lang}: ${items.join(" | ")}`).toBe(true);
        expect(items[0]).toContain(lang === "en" ? "Allow connections from outside" : "允許從外面連線");
        expect(items[1]).toContain(lang === "en" ? "fixed public hostname" : "固定公開網域");
        expect(items[2]).toContain("Tailscale");
        // The command is a <code> that never breaks across lines (as the "No chat bot?" help's).
        expect(p.get("reachPrivate")?.parts.some((x) => typeof x === "object" && x.code === "agend web --code")).toBe(true);
      }
    });
  }

  it("on the outside link a web-only fleet opened: the same web-only words (no _outside variant of these)", async () => {
    const p = await load({ marks: { "data-web-only": "1", "data-outside": "1" } });
    expect(p.get("reachTemp")?.text()).toContain("Allow connections from outside");
  });

  it("an older page cached before this change (Wi-Fi / private / outside items): the new words fill its three items in order, none blank", async () => {
    const p = await load({ ids: OLD_IDS });
    expect(p.items(["reachWifi", "reachPrivate", "reachOutside"]).map((s) => s?.split(":")[0])).toEqual(["Temporary link", "Fixed link", "Private network, such as Tailscale"]);
  });
});
