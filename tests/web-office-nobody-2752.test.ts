/**
 * #2752: an office kept for nobody — its style's NPCs only, no agent seated. `members: []` still means everyone; nobody
 * is `["team:"]` (fleet-office-model.js NOBODY, web-office-store.ts OFFICE_NOBODY): a team with no name, which no team
 * has (the web refuses one, a share drops one), so a version before this one finds nobody in it too.
 * - The page (membersOf) and the host (officeMembers, office_view, a share's scope) read it as nobody; a pick an older
 *   editor added beside it is that pick.
 * - Stored and read back as it is: the page's check (officeOk) and the host's (checkOffices, the file).
 * - Edit offices → Who is in it: Everyone / Picked / Nobody (NPCs only), each saved and read back; Picked with none
 *   ticked yet still says it shows everyone.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { OFFICE_NOBODY, OfficeStore, checkOffices } from "../src/web-office-store.js";
import { officeMembers } from "../src/web-office-acts.js";
import { OfficeShareView, type OfficeShareSource } from "../src/office-share.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const INSTANCES = [
  { name: "atlas", status: "running", backend: "claude-code" },
  { name: "quill", status: "running", backend: "kiro-cli" },
  { name: "sage", status: "running", backend: "codex" },
];
const ORG = { general: ["atlas"], teams: [{ name: "Web", members: ["quill", "sage"] }], instances: {} };
const STORE = { ready: true, instances: INSTANCES, exec: {}, awaiting: {}, needs: [] };

let p: AppPage, M: any, O: any, S: any, E: any, app: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  app = await import("/assets/app-store.js");
  O = await import("/ui/js/fleet-org.js");
  M = await import("/ui/js/fleet-office-model.js");
  S = await import("/ui/js/fleet-office-store.js");
  E = await import("/ui/js/fleet-office-editor.js");
});
afterAll(() => { p.restore(); });
beforeEach(async () => { await p.unmount(); app.appStore.set(STORE); });
const view = () => O.buildOrgView(ORG, app.appStore.get());
const names = (list: any[]) => list.map((n) => n.name);

describe("#2752 who an office holds", () => {
  it("the page: [] everyone, [NOBODY] nobody, a pick beside it that pick; the host's constant is the page's", () => {
    expect(M.NOBODY).toBe("team:");
    expect(OFFICE_NOBODY).toBe(M.NOBODY);
    expect(names(M.membersOf({ members: [] }, view()))).toEqual(["atlas", "quill", "sage"]);
    expect(M.membersOf({ members: [M.NOBODY] }, view())).toEqual([]);
    expect(names(M.membersOf({ members: [M.NOBODY, "quill"] }, view()))).toEqual(["quill"]);
    expect([[], [M.NOBODY], [M.NOBODY, M.NOBODY], [M.NOBODY, "quill"], ["team:Web"]].map(M.membersMode))
      .toEqual(["everyone", "nobody", "nobody", "picked", "picked"]);
  });
  it("never a team, even one a hand-edited fleet.yaml named \"\"", () => {
    const v = view();
    const odd = { ...v, teams: [...v.teams, { ...v.teams[0], name: "" }] };
    expect(M.membersOf({ members: [M.NOBODY] }, odd)).toEqual([]);
    const chart = { names: ["atlas", "quill"], teams: [{ name: "", members: ["atlas"] }] };
    expect(officeMembers({ members: [OFFICE_NOBODY] }, chart)).toEqual([]);
    expect(officeMembers({ members: [OFFICE_NOBODY, "quill"] }, chart)).toEqual(["quill"]);
    expect(officeMembers({ members: [] }, chart)).toEqual(["atlas", "quill"]);
  });
  it("a share of it shows nobody; a whole-fleet share still shows everyone, the office still holding nobody", () => {
    const decor = { id: "decor", name: "Decor", skin: "studio", members: [OFFICE_NOBODY] };
    const source: OfficeShareSource = {
      status: () => ({ instances: [{ name: "atlas", status: "running" }, { name: "quill", status: "running" }] }),
      org: () => ({ general: ["atlas"], teams: [{ name: "Web", members: ["quill"] }] }),
      offices: () => ({ rev: 1, offices: [decor] }),
      acts: () => [], traffic: () => ({ now: "", items: [] }), needs: () => [], hidden: () => false,
    };
    const one = new OfficeShareView({ office: "decor", text: false }, source);
    expect([...one.scope]).toEqual([]);
    const all = new OfficeShareView({ office: "auto", text: false }, source);
    expect([...all.scope].sort()).toEqual(["atlas", "quill"]);
    const [cut] = all.officeList().offices;
    expect(cut.members).toHaveLength(1);
    expect(M.membersOf(cut, view())).toEqual([]);
  });
});

describe("#2752 kept as it is", () => {
  it("the page's check and the host's keep [NOBODY]; [] stays []", () => {
    const o = (members: string[]) => ({ id: "decor", name: "Decor", skin: "studio", members });
    expect(M.officeOk(o([M.NOBODY])).members).toEqual([M.NOBODY]);
    expect(M.officeOk(o([])).members).toEqual([]);
    const checked = checkOffices([o([OFFICE_NOBODY]), { ...o([]), id: "all" }]);
    expect(checked).toMatchObject({ ok: true, offices: [{ id: "decor", members: [OFFICE_NOBODY] }, { id: "all", members: [] }] });
  });
  it("saved to web-offices.json and read back by a new store", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-nobody-")); dirs.push(dir);
    const s = new OfficeStore(dir);
    expect(s.replace([{ id: "decor", name: "Decor", skin: "studio", members: [OFFICE_NOBODY] }], 0)).toMatchObject({ ok: true, rev: 1 });
    expect(JSON.parse(readFileSync(s.path, "utf8")).offices[0].members).toEqual(["team:"]);
    expect(new OfficeStore(dir).list().offices[0].members).toEqual([OFFICE_NOBODY]);
  });
});

describe("#2752 Edit offices → Who is in it", () => {
  const mount = async (members: string[]) => {
    const puts: any[] = [];
    const store = S.createOfficeStore({ fetch: async (_u: string, o: any) => { puts.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ rev: 2, offices: [] }) }; } });
    await p.mount(h(E.OfficeEditor, { offices: [{ id: "decor", name: "Decor", skin: "studio", members, layout: null }], rev: 1, view: view(), store, onSaved: () => {}, onClose: () => {} }));
    await settle(2);
    return puts;
  };
  const button = () => p.root.querySelector(".oe-members-btn");
  const open = async () => { if (!p.root.querySelector(".oe-members")) { button().click(); await settle(2); } };
  const radios = () => p.root.querySelectorAll(".oe-who input");
  const chosen = () => radios().filter((r: any) => r.checked).map((r: any) => r.value);
  const choose = async (v: string) => { fire(radios().find((r: any) => r.value === v), "change"); await settle(2); };
  const boxes = () => p.root.querySelectorAll(".oe-members input[type=checkbox]");
  const tick = async (label: string) => { fire(boxes().find((i: any) => i.parentNode.textContent.trim() === label), "change"); await settle(2); };
  const note = () => p.root.querySelector(".oe-who .note")?.textContent.trim() ?? null;
  const save = async (puts: any[]) => { p.root.querySelector("#oeSave").click(); await settle(4); return puts.at(-1).offices[0].members; };

  it("Everyone → Nobody: saved as [NOBODY]; no boxes to tick; the button says so", async () => {
    const puts = await mount([]);
    expect(button().textContent).toContain("Who is in it: Everyone");
    await open();
    expect([radios().map((r: any) => r.value), chosen()]).toEqual([["everyone", "picked", "nobody"], ["everyone"]]);
    expect(boxes().length).toBeGreaterThan(0);
    await choose("nobody");
    expect([chosen(), boxes(), note()]).toEqual([["nobody"], [], "No agent sits here: only its style's NPCs."]);
    expect(button().textContent).toContain("Who is in it: Nobody (NPCs only)");
    expect(await save(puts)).toEqual(["team:"]);
  });
  it("read back as Nobody; → Picked (none yet: still everyone, said so) → one ticked: saved as that pick", async () => {
    const puts = await mount([M.NOBODY]);
    expect(button().textContent).toContain("Nobody (NPCs only)");
    await open();
    expect(chosen()).toEqual(["nobody"]);
    await choose("picked");
    expect([chosen(), note()]).toEqual([["picked"], "No one picked yet: it shows everyone until you pick someone."]);
    await tick("quill");
    expect([chosen(), note(), button().textContent.includes("1 picked")]).toEqual([["picked"], null, true]);
    expect(await save(puts)).toEqual(["quill"]);
  });
  it("read back as Picked; → Everyone: saved as []; unticking the last pick keeps Picked chosen (and says it shows everyone)", async () => {
    let puts = await mount(["team:Web", "quill"]);
    await open();
    expect([chosen(), boxes().filter((b: any) => b.checked).length]).toEqual([["picked"], 2]);
    await choose("everyone");
    expect([chosen(), boxes().filter((b: any) => b.checked).length]).toEqual([["everyone"], 0]);
    expect(await save(puts)).toEqual([]);
    await p.unmount();
    puts = await mount(["quill"]);
    await open();
    await tick("quill");
    expect([chosen(), note()]).toEqual([["picked"], "No one picked yet: it shows everyone until you pick someone."]);
    expect(await save(puts)).toEqual([]);
  });
  it("an older editor's pick beside NOBODY: shown as that pick (1 picked); a change drops NOBODY", async () => {
    const puts = await mount([M.NOBODY, "quill"]);
    expect(button().textContent).toContain("1 picked");
    await open();
    expect([chosen(), boxes().filter((b: any) => b.checked).map((b: any) => b.parentNode.textContent.trim())]).toEqual([["picked"], ["quill"]]);
    await tick("sage");
    expect(await save(puts)).toEqual(["quill", "sage"]);
  });
});
