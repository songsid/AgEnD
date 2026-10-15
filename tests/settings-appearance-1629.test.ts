/**
 * #1629 r4 §3: Settings → Appearance — the editor shows the text in force, Save starts a trial (the keep bar's), a
 * refused text says why in the person's words, and over the public link there is nothing to change.
 */
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { MiniEvent } from "./helpers/mini-dom.js";

const S1 = "1".repeat(32), S2 = "2".repeat(32);
let p: AppPage | null = null;
const g = globalThis as any;
afterEach(async () => { if (p) { await p.unmount(); p.restore(); p = null; } delete g.fetch; });

async function mount(opts: { publicLink?: boolean; save?: { status: number; body: unknown } } = {}) {
  p = page({ url: "http://127.0.0.1:19280/settings/appearance" });
  p.document.body.dataset.mode = "full";
  if (opts.publicLink) p.document.body.dataset.publicLink = "1";
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  g.fetch = async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? "GET", ...(typeof init.body === "string" ? { body: JSON.parse(init.body) } : {}) });
    if (url === "/ui/owner-css/state") return { ok: true, status: 200, json: async () => ({ active: S1, pending: null, text: ".x { color: red }", versions: [{ sha: S1, at: 1, bytes: 17 }], assets: [], limits: { maxAssets: 16 } }) };
    if (url === "/ui/owner-css") { const r = opts.save ?? { status: 200, body: { sha: S2, previous: S1, trial: "c".repeat(32) } }; return { ok: r.status === 200, status: r.status, json: async () => r.body }; }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const { AppearanceSection } = await import("/ui/js/settings-appearance.js");
  await p.mount(h(AppearanceSection, {}));
  await settle(); await settle();
  return { calls, oc: await import("/assets/owner-css.js") };
}

describe("Settings → Appearance", () => {
  it("shows the CSS in force, and Save starts a trial of the new one", async () => {
    const { calls, oc } = await mount();
    const area = p!.root.querySelector(".s-css-text");
    expect([area.value, p!.root.querySelector(".s-css-status").textContent]).toEqual([".x { color: red }", `In force: ${S1.slice(0, 8)}`]);
    area.value = ".x { color: blue }";
    area.dispatchEvent(new MiniEvent("input", { bubbles: true }));
    await settle();
    p!.root.querySelector(".s-css-actions .btn-primary").click();
    await settle(); await settle();
    expect(calls.find(c => c.url === "/ui/owner-css")?.body).toEqual({ text: ".x { color: blue }" });
    expect(oc.ownerCssTrial.get()).toMatchObject({ id: "c".repeat(32), sha: S2, previous: S1 });
    await oc.revertOwnerCss();                                          // end the trial this test started
  });
  it("a refused text: the reason in words, and no trial", async () => {
    const { oc } = await mount({ save: { status: 400, body: { error: "at_rule", detail: "@import" } } });
    p!.root.querySelector(".s-css-actions .btn-primary").click();
    await settle(); await settle();
    expect([p!.root.querySelector(".s-owner-css .err")?.textContent, oc.ownerCssTrial.get()]).toEqual(["Not saved: @import isn't allowed.", null]);
  });
  it("over the public link: only that it is not available here; nothing is read", async () => {
    const { calls } = await mount({ publicLink: true });
    expect([p!.root.querySelector(".s-css-text"), p!.root.textContent.includes("isn't available on a temporary public link"), calls]).toEqual([null, true, []]);
  });
});
