/**
 * The Office, for the one looking at it (this browser only):
 * - names this browser gives people: kept short and one line (renamesOk), saved and given back (saveRename), and put on
 *   the org view (renamedView) so the tags, the card and the dialogue show them;
 * - the card's pencil: a field with the name shown; Enter or leaving it saves, Escape does not, empty gives back their own;
 * - "Hide names and levels" is kept here (namesOff).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, F: any, S: any, card: any;
beforeAll(async () => {
  p = page();
  F = await import("/ui/js/fleet-office.js");
  S = await import("/ui/js/fleet-office-store.js");
  card = await import("/ui/js/fleet-office-card.js");
});
afterAll(() => p.restore());

describe("names this browser gives", () => {
  it("renamesOk: one-line strings up to 24 characters; anything else is dropped", () => {
    expect(S.renamesOk({ general: "  陽奈 ", a: "", b: "x".repeat(25), c: 3, d: "two\nlines" })).toEqual({ general: "陽奈", d: "twolines" });
    expect([S.renamesOk(null), S.renamesOk(["a"]), S.renamesOk("x")]).toEqual([{}, {}, {}]);
  });
  it("the store: saved and read back; empty gives back their own; hide names kept", () => {
    p.storage.clear();
    const s = S.createOfficeStore({});
    expect([s.renames(), s.namesOff()]).toEqual([{}, false]);
    expect(s.saveRename("general", "陽奈")).toEqual({ general: "陽奈" });
    expect(s.saveRename("atlas", "Atlas 2")).toEqual({ general: "陽奈", atlas: "Atlas 2" });
    expect(s.saveRename("general", "")).toEqual({ atlas: "Atlas 2" });
    expect(S.createOfficeStore({}).renames()).toEqual({ atlas: "Atlas 2" });
    s.saveNamesOff(true);
    expect(S.createOfficeStore({}).namesOff()).toBe(true);
  });
  it("renamedView: a renamed person's nickname, wherever they are in the view; the rest and an empty map untouched", () => {
    const n = (name: string) => ({ name, i: { name, display_name: "" }, info: {}, state: "idle" });
    const view = { top: [n("general")], teams: [{ name: "T", nodes: [n("atlas"), n("echo")] }], rest: { nodes: [n("solo"), { name: "gone", i: null }], counts: [] }, total: 4, counts: [] };
    expect(F.renamedView(view, {})).toBe(view);
    const r = F.renamedView(view, { general: "陽奈", echo: "E", gone: "G" });
    expect([r.top[0].i.display_name, r.teams[0].nodes[0], r.teams[0].nodes[1].i.display_name, r.rest.nodes[0], r.rest.nodes[1]])
      .toEqual(["陽奈", view.teams[0].nodes[0], "E", view.rest.nodes[0], view.rest.nodes[1]]);
    expect(view.top[0].i.display_name).toBe("");                                           // the given view is not changed
  });
});

describe("the card's pencil", () => {
  const mounted: AppPage[] = [];
  afterEach(async () => { for (const m of mounted.splice(0)) { await m.unmount(); m.restore(); } });
  const el = (rename: any, state = "Idle") => {
    const model = card.cardModel({ node: { name: "general", i: { name: "general", display_name: "" } }, lv: null, levels: null, share: true, rows: [], display: "", state, now: "", where: "" });
    return h(card.OfficeCard, { model, avatar: () => {}, sheet: false, place: () => {}, onFind: () => {}, onClose: () => {}, rename });
  };
  const open = async (rename: any) => {
    const m = page(); mounted.push(m);
    await m.mount(el(rename));
    await settle(4);
    return m;
  };
  it("none without rename (a share link): just the name", async () => {
    const m = await open(null);
    expect([m.root.querySelector(".oo-card-name")?.textContent, m.root.querySelector(".oo-card-rename-btn")]).toEqual(["general", null]);
  });
  it("Enter saves what was typed; Escape keeps the name; leaving the field saves", async () => {
    const saved: string[] = [];
    const m = await open({ value: "", save: (v: string) => saved.push(v) });
    const edit = async () => { fire(m.root.querySelector(".oo-card-rename-btn") as any, "click"); await settle(4); return m.root.querySelector(".oo-card-rename") as any; };
    let f = await edit();
    expect([f.value, f.getAttribute("maxlength"), f.getAttribute("aria-label")]).toEqual(["general", "24", "Name you see"]);
    f.value = " 陽奈 "; fire(f, "keydown", { key: "Enter" }); await settle(4);
    expect([saved, m.root.querySelector(".oo-card-rename")]).toEqual([["陽奈"], null]);
    f = await edit(); f.value = "no"; fire(f, "keydown", { key: "Escape" }); await settle(4);
    expect(saved).toEqual(["陽奈"]);
    f = await edit(); f.value = ""; fire(f, "blur"); await settle(4);
    expect(saved).toEqual(["陽奈", ""]);
  });
  it("what is typed stays when the card draws again (a live office redraws it with each status)", async () => {
    const saved: string[] = [];
    const rename = { value: "", save: (v: string) => saved.push(v) };
    const m = await open(rename);
    fire(m.root.querySelector(".oo-card-rename-btn") as any, "click"); await settle(4);
    const f = m.root.querySelector(".oo-card-rename") as any;
    f.value = "陽奈";
    await m.mount(el(rename, "Crashed")); await settle(4);
    expect(m.root.querySelector(".oo-card-rename")?.value).toBe("陽奈");
    fire(f, "keydown", { key: "Enter" }); await settle(4);
    expect(saved).toEqual(["陽奈"]);
  });
});
