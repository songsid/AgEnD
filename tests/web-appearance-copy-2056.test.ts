/**
 * #2056 B: Settings → Web appearance in plain words.
 * - The cards sit under five plain headings, in both languages.
 * - Each card's title carries a small "?" that opens its section of docs/web-dashboard(.zh-TW).md on GitHub (a new tab,
 *   no opener); every anchor is a heading that exists in that file, so the link lands on the explanation.
 * - Each card keeps at most one short hint line per control: no paragraph on the page runs long.
 * - The colour card shows a sample row painted with the host's default places, which follows the checkboxes.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

let limitsOk = true;
const fetchFake = async (url: string, init: any = {}) => {
  if (url === "/ui/app-icon") return { ok: true, status: 200, json: async () => ({ custom: false, version: "default", updatedAt: null }) };
  if (url === "/ui/mods") return { ok: true, status: 200, json: async () => ({ mods: [], proposals: [] }) };
  if (url === "/api/settings/fleet/appearance" && !limitsOk) return { ok: false, status: 403, json: async () => ({ error: "forbidden" }) };
  if (url === "/ui/prefs") return { ok: true, status: 200, json: async () => ({ values: {}, rev: 1 }) };
  if (url === "/ui/owner-css/state") return { ok: true, status: 200, json: async () => ({ active: null, pending: null, text: "", versions: [], assets: [], limits: { maxAssets: 16 } }) };
  if (url === "/api/settings/fleet/appearance") {
    const group = (v: number) => ({ portrait: { max_width: v, max_height: v, max_kib: v }, banner: { max_width: v, max_height: v, max_kib: v }, instance_quota: { files: v, mib: v } });
    return { ok: true, status: 200, json: async () => ({ configured: {}, effective: group(512), defaults: group(512), bounds: { portrait: { max_width: [1, 9], max_height: [1, 9], max_kib: [1, 9] },
      banner: { max_width: [1, 9], max_height: [1, 9], max_kib: [1, 9] }, instance_quota: { files: [1, 9], mib: [1, 9] } }, warnings: [] }) };
  }
  void init;
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};
const g = globalThis as any;
let pg: AppPage | null = null;
afterEach(async () => { if (pg) { await pg.unmount(); pg.restore(); pg = null; } });
/** #2347: Look (the person's own cards), or Web dashboard's part (the app icon, card upload limits) — "dashboard". */
async function mount(lang: "en" | "zh-TW", part: "look" | "dashboard" = "look") {
  pg = page({ url: "http://127.0.0.1:19280/settings/appearance", storage: { agend_tour_done: "1" } });
  pg.document.body.dataset.mode = "full";
  (await import("/assets/app-store.js")).appStore.set({ canvasWorker: true });
  g.fetch = fetchFake;
  (await import("/assets/app-i18n.js")).setLang(lang, { store: false });
  const { AppearanceSection } = await import("/ui/js/settings-appearance.js");
  await pg.mount(h(AppearanceSection, { part }));
  await settle(3);
  if (part === "look") await vi.waitFor(() => expect(pg!.root.querySelector(".s-effects")).not.toBeNull());
  return pg.root;
}
const titles = (root: any) => [...root.querySelectorAll("h2.s-ap-group, h3.s-ap-title > span")].map((e: any) => `${e.tagName === "H2" ? "# " : ""}${e.textContent}`);

/** GitHub's heading anchor: lower-cased, punctuation dropped (letters of any script kept), each space a hyphen. */
function slugs(md: string) {
  const seen = new Map<string, number>(), out = new Set<string>();
  for (const line of md.split("\n")) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = m[1].trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

describe("Settings → Web appearance in plain words", () => {
  it("four plain headings in Look, each over its cards, in both languages; the host-wide cards in Web dashboard (#2347)", async () => {
    expect(titles(await mount("en"))).toEqual(["# Look", "Agents' themes", "Identity colours", "Identity cards", "# Your layout", "Your sidebar widget",
      "# Styles you write", "Custom CSS (yours only)", "# Add-ons", "Mods", "Effects", "Restore defaults"]);
    await pg!.unmount(); pg!.restore(); pg = null;
    const zh = titles(await mount("zh-TW"));
    expect(zh.filter((t) => t.startsWith("# "))).toEqual(["# 外觀", "# 你的版面", "# 自己寫的樣式", "# 擴充"]);
    await pg!.unmount(); pg!.restore(); pg = null;
    expect(titles(await mount("en", "dashboard"))).toEqual(["App icon", "Identity card upload limits"]);
  });

  it("every card's \"?\" opens its own section of the docs, in the page's language", async () => {
    const { LEARN_ANCHORS, learnHref } = await import("/ui/js/settings-learn.js");
    const en = slugs(readFileSync("docs/web-dashboard.md", "utf8")), zh = slugs(readFileSync("docs/web-dashboard.zh-TW.md", "utf8"));
    for (const [topic, [a, b]] of Object.entries(LEARN_ANCHORS as Record<string, [string, string]>)) {
      expect(en.has(a), `en ${topic}: #${a}`).toBe(true);
      expect(zh.has(b), `zh-TW ${topic}: #${b}`).toBe(true);
      expect(learnHref(topic, "en")).toBe(`https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.md#${encodeURIComponent(a)}`);
      expect(learnHref(topic, "zh-TW")).toBe(`https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.zh-TW.md#${encodeURIComponent(b)}`);
    }
    for (const [lang, part, count] of [["en", "look", 8], ["zh-TW", "look", 8], ["en", "dashboard", 2], ["zh-TW", "dashboard", 2]] as const) {
      const root = await mount(lang, part);
      const links = [...root.querySelectorAll("a.s-learn")] as any[];
      expect(links.length, `${lang} ${part}: one per card (#2308: the app icon's too)`).toBe(count);
      for (const a of links) {
        expect(a.getAttribute("href")).toMatch(lang === "en" ? /^https:\/\/github\.com\/songsid\/AgEnD\/blob\/main\/docs\/web-dashboard\.md#/
          : /^https:\/\/github\.com\/songsid\/AgEnD\/blob\/main\/docs\/web-dashboard\.zh-TW\.md#/);
        expect([a.getAttribute("target"), a.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
        expect(a.getAttribute("aria-label")).toBe(lang === "en" ? `Learn more: ${a.parentNode.querySelector("span").textContent}` : `了解更多：${a.parentNode.querySelector("span").textContent}`);
      }
      await pg!.unmount(); pg!.restore(); pg = null;
    }
  });

  it("no hint on the page runs long (was up to 306 characters in English, 150 in Chinese), for an admin or not", async () => {
    for (const [lang, max, admin] of [["en", 70, true], ["zh-TW", 40, true], ["en", 70, false], ["zh-TW", 40, false]] as const) {
      limitsOk = admin;
      const dash = await mount(lang, "dashboard");
      expect(!!dash.querySelector(".s-appearance input[type=number]"), `${lang} admin=${admin}: the limits form`).toBe(admin);
      const dashHints = [...dash.querySelectorAll("p.sub, p.note")].map((p: any) => p.textContent.trim()).filter(Boolean);
      await pg!.unmount(); pg!.restore(); pg = null;
      const root = await mount(lang);
      const hints = [...dashHints, ...[...root.querySelectorAll("p.sub, p.note")].map((p: any) => p.textContent.trim()).filter(Boolean)];
      expect(hints.length, lang).toBeGreaterThan(5);
      for (const text of hints) expect(text.length, `${lang}: ${text}`).toBeLessThanOrEqual(max);
      await pg!.unmount(); pg!.restore(); pg = null;
    }
    limitsOk = true;
  });

  it("custom CSS's pictures and fonts: the 1 MiB limit is for all of them together, as the store enforces (not each)", async () => {
    for (const [lang, total, each] of [["en", /in total \(at most 1 MiB in all\)/, /each/], ["zh-TW", /合計.*全部合計最多 1 MiB/, /每個/]] as const) {
      const root = await mount(lang);
      const line = [...root.querySelectorAll(".s-owner-css p.sub")].map((p: any) => p.textContent).find((x: string) => x.includes("1 MiB"));
      expect(line, lang).toMatch(total);
      expect(line, lang).not.toMatch(each);
      await pg!.unmount(); pg!.restore(); pg = null;
    }
    const { OWNER_CSS_MAX_ASSET_BYTES } = await import("../src/web-owner-css-store.js");
    expect(OWNER_CSS_MAX_ASSET_BYTES, "the store's one limit, for all of a person's assets").toBe(1024 * 1024);
  });

  it("Restore defaults asks first, in Chinese too, naming what it resets and what it keeps; no keeps everything", async () => {
    const asked: string[] = [];
    const root = await mount("zh-TW");
    g.confirm = (m: string) => { asked.push(m); return false; };          // after the page: it installs its own
    try {
      const posts: string[] = [];
      const inner = g.fetch;
      g.fetch = async (url: string, init: any = {}) => { if (init.method === "POST") posts.push(url); return inner(url, init); };
      root.querySelector(".s-restore button").click();
      await settle(3); await new Promise((r) => setTimeout(r, 450)); await settle();
      expect(asked).toHaveLength(1);
      for (const item of ["是否顯示 agent 的主題與效果", "卡片大小與各張卡片自己的大小", "你的側欄小工具", "顏色顯示的位置", "是否關閉顏色", "關閉你的自訂 CSS", "這台裝置上的 CSS 開關",
        "不變：有人替 agent 挑的顏色、已安裝的 mod、上傳的效果與卡片上限。"]) expect(asked[0], item).toContain(item);
      expect(posts, "no: nothing written").toEqual([]);
    } finally { delete g.confirm; }
  });

  it("the colour card's sample row is painted with the default places and follows the checkboxes", async () => {
    const root = await mount("en");
    const row = () => root.querySelector(".s-colors-sample .inst");
    const prop = (k: string) => (row().style as any)[k] ?? row().style.getPropertyValue?.(k) ?? undefined;
    expect(row().className.split(" ").filter((c: string) => c.startsWith("id")).sort()).toEqual(["id-bar", "id-name", "id-ring", "idc"]);
    expect([prop("--id-light"), prop("--id-dark")], "the teal swatch").toEqual(["#0f766e", "#2dd4bf"]);
    const [name] = [...root.querySelectorAll(".s-colors .idc-places input")] as any[];
    name.dispatchEvent(new g.Event("change", { bubbles: true }));
    await settle(2);
    expect(row().className.split(" ").filter((c: string) => c.startsWith("id")).sort(), "name unticked").toEqual(["id-bar", "id-ring", "idc"]);
    const off = root.querySelector(".s-colors-off");
    off.checked = true; off.dispatchEvent(new g.Event("change", { bubbles: true }));
    await settle(2);
    expect(row().className.split(" ").filter((c: string) => c.startsWith("id")), "colours off: nothing painted").toEqual([]);
    expect(prop("--id-light")).toBeFalsy();
    // Leave the host's prefs as they were for the next test file.
    const C = await import("/assets/identity-color.js");
    C.setDefaultPlaces(null); C.setColorsOff(false);
    await new Promise((r) => setTimeout(r, 450));
  });
});
