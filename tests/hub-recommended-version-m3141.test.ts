/**
 * M-3141 (docs/design/hub-fleet-versions.md §3.1, §3.4; API M-3138): Administration's "Recommended AgEnD version" card —
 * Same as this Hub / A specific version / No recommendation; the effect previewed before Save (an npm check only once the
 * person acts, never for opening the page); Save guarded by the revision; each refusal in its own words — and, per
 * Connected fleets row, "Owner notified · {when}" / "Not notified yet". The summary's "Set a recommended version…"
 * clause is back where the setting exists.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let v: any, words: any; const pages: AppPage[] = [];
beforeAll(async () => { const p = page(); v = await import("/ui/js/hub-fleet-versions.js"); words = await import("/assets/app-i18n.js"); p.restore(); });
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } vi.restoreAllMocks(); });
const until = async (fn: () => unknown) => { for (let i = 0; i < 120 && !fn(); i++) await settle(5); expect(fn()).toBeTruthy(); };

const NOW = Date.now(), MIN = 60_000;
const FLEETS = [
  { id: "a", status: "active", version: "2.4.0", versionState: "current", recommendationNotifiedAt: null },
  { id: "b", status: "active", version: "2.3.4", versionState: "needs-update", recommendationNotifiedAt: NOW - 5 * MIN },
  { id: "c", status: "active", version: null, versionState: "unknown", recommendationNotifiedAt: null },
];

function client(o: { get?: any; preview?: (b: any) => any; save?: (b: any) => any } = {}) {
  let saved = o.get ?? { ok: true, mode: "none", version: null, recommendedVersion: null, hubVersion: "2.4.0", configured: false, revision: 0, setAt: null };
  return {
    recommendedVersion: vi.fn(async () => saved),
    previewRecommendedVersion: vi.fn(async (b: any) => o.preview ? o.preview(b) : { ok: true, recommendedVersion: b.mode === "specific" ? b.version : "2.4.0", affected: 3, revision: saved.revision }),
    saveRecommendedVersion: vi.fn(async (b: any) => { const r = o.save ? o.save(b) : null; if (r) return r;
      saved = { ok: true, mode: b.mode, version: b.mode === "specific" ? b.version : null, recommendedVersion: b.mode === "none" ? null : b.version ?? "2.4.0", hubVersion: "2.4.0", configured: true, revision: saved.revision + 1, setAt: NOW };
      return saved; }),
  };
}
async function card(c: any, lang = "en") {
  const p = page({ url: "https://hub.example.test/ui/hub/admin", storage: { agend_lang: lang } }); pages.push(p); words.setLang(lang);
  const saved = vi.fn(), available = vi.fn();
  await p.mount(h(v.RecommendedVersionCard, { client: c, onSaved: saved, onAvailable: available })); await settle(10);
  return { p, saved, available, q: (sel: string) => p.root.querySelector(sel) as any };
}
const radioOf = (p: AppPage, value: string) => [...p.root.querySelectorAll(".hub-rec-choices input")].find((i: any) => i.type === "radio" && i.value === value) as any;
const saveBtn = (p: AppPage) => [...p.root.querySelectorAll(".hub-rec-card button")].find((b: any) => /Save|儲存/.test(b.textContent)) as any;

describe("the words (pure)", () => {
  it("Owner notified · when / Not notified yet — only for a behind Fleet once a recommendation is set", () => {
    words.setLang("en");
    expect(FLEETS.map((f) => v.notifiedText(f, "2.4.0", NOW))).toEqual(["", "Owner notified · 5 minutes ago", "Not notified yet"]);
    expect(v.notifiedText(FLEETS[1], null, NOW)).toBe("");
    words.setLang("zh-TW");
    expect(v.notifiedText(FLEETS[1], "2.4.0", NOW)).toBe("已通知擁有者 · 5 分鐘前");
  });
  it("the summary's clause is back only where the setting exists", () => {
    words.setLang("en");
    expect([v.summaryText(FLEETS, null, true), v.summaryText(FLEETS, null, false)]).toEqual(["3 active Fleets. Set a recommended version to see which ones are behind.", "3 active Fleets."]);
  });
  it("each refusal in its own words, naming the version entered", () => {
    words.setLang("en");
    expect(["version-invalid", "version-not-found", "npm-unavailable", "hub-version-unknown", "revision-conflict", "csrf"].map((code) => v.refusalText({ ok: false, code }, "9.9.9"))).toEqual([
      "Enter a version number such as 2.4.0.", "Version 9.9.9 was not found on npm.", "Couldn't reach npm to check 9.9.9. Try again.",
      "This Hub's own version can't be read. Choose a specific version.", "Someone else changed this just now; their choice is shown. Check it and save again.", "It wasn't saved. Try again."]);
  });
});

describe("the card", () => {
  it("nothing saved yet: Same as this Hub (2.4.0) is chosen, and opening the page checks nothing on npm; Save previews, Save again applies", async () => {
    const c = client(), { p, saved, available } = await card(c);
    expect([radioOf(p, "hub").checked, p.root.querySelector(".hub-rec-card label").textContent, available.mock.calls[0]?.[0]]).toEqual([true, "Same as this Hub (2.4.0)", true]);
    expect(c.previewRecommendedVersion).not.toHaveBeenCalled();
    fire(saveBtn(p), "click"); await until(() => p.root.querySelector(".hub-rec-preview")?.textContent === "3 Fleets will be asked to update.");
    expect(c.previewRecommendedVersion).toHaveBeenCalledWith({ mode: "hub" });
    expect(c.saveRecommendedVersion).not.toHaveBeenCalled();
    fire(saveBtn(p), "click"); await until(() => c.saveRecommendedVersion.mock.calls.length === 1);
    expect(c.saveRecommendedVersion).toHaveBeenCalledWith({ mode: "hub", ifRevision: 0 });
    await until(() => saved.mock.calls.length === 1);
    expect(saveBtn(p), "saved: nothing left to save").toBeUndefined();
  });

  it("a specific version: previewed as typed; one npm does not have is refused in words and cannot be saved", async () => {
    const c = client({ preview: (b) => b.version === "9.9.9" ? { ok: false, status: 422, code: "version-not-found" } : { ok: true, recommendedVersion: b.version, affected: 1, revision: 0 } });
    const { p } = await card(c);
    fire(radioOf(p, "specific"), "change"); await settle(3);
    const box = p.root.querySelector("#hubRecVersion") as any; box.value = "9.9.9"; fire(box, "input");
    await until(() => p.root.querySelector(".hub-rec-card .err")?.textContent === "Version 9.9.9 was not found on npm.");
    expect([c.previewRecommendedVersion.mock.calls.at(-1)?.[0], saveBtn(p).disabled]).toEqual([{ mode: "specific", version: "9.9.9" }, true]);
    box.value = "2.4.1"; fire(box, "input");
    await until(() => p.root.querySelector(".hub-rec-preview")?.textContent === "1 Fleet will be asked to update.");
    expect(saveBtn(p).disabled).toBe(false);
  });

  it("someone else saved meanwhile: the conflict is said, and their choice is read again", async () => {
    const c = client({ save: () => ({ ok: false, status: 409, code: "revision-conflict" }) });
    const { p, saved } = await card(c);
    fire(radioOf(p, "none"), "change"); await until(() => p.root.querySelector(".hub-rec-preview"));
    expect(p.root.querySelector(".hub-rec-preview").textContent).toBe("No Fleet will be asked to update.");
    fire(saveBtn(p), "click"); await until(() => p.root.querySelector('.hub-rec-card [role="alert"]'));
    expect(p.root.querySelector('.hub-rec-card [role="alert"]').textContent).toBe("Someone else changed this just now; their choice is shown. Check it and save again.");
    expect([c.recommendedVersion.mock.calls.length, saved.mock.calls.length]).toEqual([2, 1]);
  });

  it("an older Hub without the setting: no card, and the page is told (the summary keeps its plain line)", async () => {
    const c = { recommendedVersion: vi.fn(async () => ({ ok: false, status: 404, code: "not-found" })) };
    const { p, available } = await card(c);
    expect([p.root.querySelector(".hub-rec-card"), available.mock.calls[0]?.[0]]).toEqual([null, false]);
  });

  it("a saved specific version opens on it (zh-TW), with nothing to save until it changes", async () => {
    const c = client({ get: { ok: true, mode: "specific", version: "2.4.0-beta.3", recommendedVersion: "2.4.0-beta.3", hubVersion: "2.4.0", configured: true, revision: 4, setAt: NOW } });
    const { p } = await card(c, "zh-TW");
    expect([radioOf(p, "specific").checked, (p.root.querySelector("#hubRecVersion") as any).value, saveBtn(p), p.root.querySelector(".hub-rec-card h3").textContent])
      .toEqual([true, "2.4.0-beta.3", undefined, "建議的 AgEnD 版本"]);
  });
});

it("a Connected fleets row: the notified line under its tag", async () => {
  const p = page({ storage: { agend_lang: "en" } }); pages.push(p); words.setLang("en");
  await p.mount(h("div", {}, ...FLEETS.map((f) => h("div", { "data-fleet": f.id }, h(v.FleetVersionCells, { fleet: f, recommended: "2.4.0", now: NOW }))))); await settle(3);
  expect(["a", "b", "c"].map((id) => p.root.querySelector(`[data-fleet="${id}"] .hub-fleet-notified`)?.textContent ?? null))
    .toEqual([null, "Owner notified · 5 minutes ago", "Not notified yet"]);
});
