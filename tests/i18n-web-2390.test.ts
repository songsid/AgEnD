/**
 * #2390 part 2: words the host sends that a web page shows, in the page's language.
 * - App icon: a refusal's detail is named (detail_key / detail_args) as well as said in English; the page says it in
 *   its language (Settings → Appearance), and a detail it has no words for stays as sent.
 * - Task board: "not available" carries a key the board's error text knows.
 * - Mods: the Canvas Worker refusal in the page's words, not "canvas_worker_experimental: <English>".
 * - The /login web terminal page: its static words in zh-TW on a zh device, from one table with the same placeholders.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { AppIconStore, convertInProcess } from "../src/web-app-icon.js";
import { encodePng } from "../src/web-png.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

let pg: AppPage | null = null;
const dirs: string[] = [];
afterEach(async () => {
  if (pg) { (await import("/assets/app-i18n.js")).setLang("en", { store: false }); pg.restore(); pg = null; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function lang(l: "en" | "zh-TW") {
  pg = page({ url: "http://127.0.0.1:19280/settings/appearance", storage: { agend_tour_done: "1" } });
  (await import("/assets/app-i18n.js")).setLang(l, { store: false });
}
const png = (w: number, h: number) => encodePng({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(255) } as any);

describe("#2390 app icon refusals: named by the host, said by the page", () => {
  it("the host names each detail beside its English", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-2390-icon-")); dirs.push(dir);
    const store = new AppIconStore(dir, () => new Date(), convertInProcess);
    expect(await store.prepare(new Uint8Array(6 * 1024 * 1024))).toMatchObject({ error: "app_icon_too_large", detail: "at most 5 MiB", detail_key: "max_size", detail_args: [5] });
    expect(await store.prepare(new Uint8Array([1, 2, 3]))).toMatchObject({ error: "app_icon_not_png", detail_key: "png_only" });
    expect(await store.prepare(png(600, 500))).toMatchObject({ error: "app_icon_unreadable", detail: "not square (600×500)", detail_key: "not_square", detail_args: [600, 500] });
    expect(await store.prepare(png(64, 64))).toMatchObject({ error: "app_icon_unreadable", detail_key: "too_small" });
  });

  it("the page says the detail in its language; one it has no words for stays as sent", async () => {
    await lang("zh-TW");
    const { appIconDetail } = await import("/ui/js/settings-appearance.js");
    const { t } = await import("/assets/app-i18n.js");
    expect(appIconDetail({ detail: "at most 5 MiB", detail_key: "max_size", detail_args: [5] })).toBe("最多 5 MiB");
    expect(appIconDetail({ detail: "not square (600×500)", detail_key: "not_square", detail_args: [600, 500] })).toBe("不是正方形（600×500）");
    expect(appIconDetail({ detail: "bad chunk CRC", detail_key: "corrupt", detail_args: [] })).toBe("無法解讀這個 PNG 檔案（bad chunk CRC）");
    expect(appIconDetail({ detail: "something new", detail_key: "from_a_newer_host" })).toBe("something new");
    expect(appIconDetail({ detail: "an older host" })).toBe("an older host");
    expect(t("settings.appIconError_app_icon_too_large", appIconDetail({ detail: "at most 5 MiB", detail_key: "max_size", detail_args: [5] }))).toBe("圖片太大（最多 5 MiB）。");
    expect(t("settings.appIconError_app_icon_not_kept")).toBe("這個 fleet 沒有保存 App 圖示。");
  });

  it("in English the page reads as before", async () => {
    await lang("en");
    const { appIconDetail } = await import("/ui/js/settings-appearance.js");
    expect(appIconDetail({ detail: "at most 5 MiB", detail_key: "max_size", detail_args: [5] })).toBe("at most 5 MiB");
  });
});

describe("#2390 the task board and Mods", () => {
  it("the board's 'not available' is a key its error text knows, in both languages", async () => {
    const web = readFileSync(join(process.cwd(), "src", "web-api.ts"), "utf8");
    expect(web).toContain('json(res, 503, { error: "The task board is not available", code: "unavailable", key: "unavailable" })');
    await lang("zh-TW");
    const { errorText } = await import("/ui/js/fleet-task-common.js");
    expect(errorText({ key: "unavailable", message: "The task board is not available" })).toBe("看板目前無法使用");
  });

  it("a mod refused for Canvas Worker effects says so in the page's words", async () => {
    await lang("zh-TW");
    const { t } = await import("/assets/app-i18n.js");
    await import("/ui/js/settings-strings.js");
    expect(t("settings.modCanvasWorkerOff")).toContain("Canvas Worker");
    expect(t("settings.modCanvasWorkerOff")).toMatch(/^未完成：/);
    const mods = readFileSync(join(process.cwd(), "src", "ui", "settings-mods.js"), "utf8");
    expect(mods).toContain('if (body.error === "canvas_worker_experimental") return tn("modCanvasWorkerOff");');
  });
});

describe("#2390 the /login web terminal page", () => {
  const js = readFileSync(join(process.cwd(), "src", "ui", "web-terminal", "terminal.js"), "utf8");
  const html = readFileSync(join(process.cwd(), "src", "ui", "web-terminal", "terminal.html"), "utf8");
  const words = Object.fromEntries([...js.matchAll(/^\s+"?([\w.-]+)"?: \[("(?:[^"\\]|\\.)*"),\s*("(?:[^"\\]|\\.)*")\]/gm)].map((m) => [m[1], [JSON.parse(m[2]!), JSON.parse(m[3]!)]]));

  it("every word the page marks (data-i18n…) is in the table, with zh-TW text", () => {
    const marked = [...html.matchAll(/data-i18n(?:-html|-title|-placeholder)?="([^"]+)"/g)].map((m) => m[1]!);
    expect(marked.length).toBeGreaterThanOrEqual(10);
    for (const k of marked) expect(words[k]?.[1], k).toBeTruthy();
  });

  it("each zh-TW entry keeps its English's {n} placeholders, and every T(\"…\") the script calls is in the table", () => {
    const ph = (s: string) => (s.match(/\{\d\}/g) ?? []).join(",");
    for (const [k, [en, zh]] of Object.entries(words) as Array<[string, [string, string]]>) {
      expect(zh, k).toBeTruthy();
      if (en) expect(ph(zh), k).toBe(ph(en));
    }
    for (const m of js.matchAll(/\bT\("([\w.-]+)"[,)]/g)) expect(words[m[1]!], m[1]).toBeDefined();
  });

  it("English stays in the page itself (a device in English, or no script, reads it as before)", () => {
    expect(html).toContain("access token");
    expect(html).toContain('<html lang="en">');
  });
});
