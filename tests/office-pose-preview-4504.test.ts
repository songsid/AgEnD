/**
 * #4504: preview a character's poses from their profile card (a skin pack's).
 * - PREVIEW_POSES / previewLook: every pose a set may draw; a walking direction walks on the spot; any other pose keeps
 *   the person's own as its fallback (a set without the strip draws its own pose).
 * - The card: the picker and Replay only when given `preview`; picking calls set; Replay waits for a pose.
 * - drawPart: the picked pose on that person only, from its first frame (`clip`); never over a call; not while walking.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as PK from "../src/ui/fleet-office-pack.js";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

describe("what the preview offers, and the look it draws", () => {
  it("every pose a set may draw, walking by direction", () => {
    expect(PK.PREVIEW_POSES).toEqual(["idle", "working", "paused", "needs", "walkDown", "walkUp", "walkSide", "walkLeft", "eat", "pat", "dragged", "stand"]);
  });
  it("a walking direction walks on the spot; any other pose keeps the person's own as its fallback", () => {
    const look = { name: "a", pose: "working" };
    expect(PK.previewLook(look, "walkLeft")).toMatchObject({ pose: "walk", heading: { dx: -1, dy: 0 } });
    expect(PK.previewLook(look, "walkUp")).toMatchObject({ pose: "walk", heading: { dx: 0, dy: -1 } });
    expect(PK.previewLook(look, "pat")).toMatchObject({ pose: "pat", basePose: "working" });
    const set = { idle: PK.checkStrip({ src: "i.png", frames: 1, w: 32, h: 48 }, "idle"), walkSide: PK.checkStrip({ src: "r.png", frames: 1, w: 32, h: 48 }, "walkSide") };
    const l = PK.previewLook(look, "walkLeft");
    expect(PK.poseStrip(set, l.pose, l.heading)).toMatchObject({ strip: { src: "r.png" }, mirror: true });   // no walkLeft: walkSide mirrored
    expect(PK.poseStrip(set, "eat")).toMatchObject({ strip: { src: "i.png" } });                         // no eat strip: idle
  });
});

describe("the card's picker and Replay", () => {
  let card: any;
  const mounted: AppPage[] = [];
  beforeAll(async () => { const p = page(); card = await import("/ui/js/fleet-office-card.js"); p.restore(); });
  afterEach(async () => { for (const p of mounted.splice(0).reverse()) { await p.unmount(); p.restore(); } });
  const open = async (preview: any) => {
    const p = page(); mounted.push(p);
    const model = card.cardModel({ node: { name: "n", display_name: "Notes", status: "running", execution_state: "idle" }, lv: () => 1, levels: null, share: false, rows: [], display: "Notes", state: "Idle", now: "", where: "" });
    await p.mount(h(card.OfficeCard, { model, avatar: () => {}, sheet: false, place: () => {}, onFind: () => {}, onClose: () => {}, preview }));
    await settle(4);
    return p.root;
  };
  it("absent without `preview` (no pack, All offices, a desks layout)", async () => {
    expect((await open(null)).querySelector(".oo-card-preview")).toBeNull();
  });
  it("Off first, then every pose; picking one calls set; Replay is off until a pose is picked", async () => {
    const picked: string[] = [];
    let replays = 0;
    const root = await open({ poses: PK.PREVIEW_POSES, pose: "", set: (v: string) => picked.push(v), replay: () => { replays++; } });
    const sel = root.querySelector(".oo-card-preview select") as any;
    expect([...sel.querySelectorAll("option")].map((o: any) => o.value ?? o.getAttribute("value"))).toEqual(["", ...PK.PREVIEW_POSES]);
    expect(root.querySelector(".oo-card-preview label")!.textContent).toContain("Preview pose");
    sel.value = "walkUp"; fire(sel, "change");
    expect(picked).toEqual(["walkUp"]);
    expect((root.querySelector(".oo-card-replay") as any).disabled).toBe(true);
    const on = await open({ poses: PK.PREVIEW_POSES, pose: "pat", set: () => {}, replay: () => { replays++; } });
    const replay = on.querySelector(".oo-card-replay") as any;
    expect(replay.disabled).toBe(false);
    fire(replay, "click");
    expect(replays).toBe(1);
  });
});

describe("drawn (drawPart)", () => {
  let p: AppPage, Z: any, K: any, F: any;
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
    Z = await import("/ui/js/fleet-office-zones.js");
    K = await import("/ui/js/fleet-office-skin.js");
    F = await import("/ui/js/fleet-office.js");
  });
  afterAll(async () => { await p.unmount(); p.restore(); });
  /** Cozy, two agents (`state` and an idle one), the preview `pv`: what drawCharacter got for each. */
  function drawn(state: string, pv: any) {
    const base = K.SKINS.get("cozy"), calls = new Map<string, any>();
    const skin = { ...base, drawCharacter: (_c: any, _b: any, look: any, ms: number) => calls.set(look.name, { look, ms }), drawFurniture() {}, drawBackground() {}, drawTag() {}, drawBubble() {} };
    const nodes = [{ name: "example-agent", state, i: { name: "example-agent" } }, { name: "general", state: "idle", i: { name: "general" } }];
    const L = Z.zonesLayout(base.pack, nodes);
    const looks = new Map(L.rooms.flatMap((r: any) => r.desks).filter((d: any) => d.node).map((d: any) => [d.key,
      { name: d.node.name, label: d.node.name, state: d.node.state, pose: d.node.state }]));
    const part = { ...F.partOf(L, looks, skin, true, Z.createWalkers(), { frame: () => [], size: () => 0 }), lang: "en", preview: { current: pv } };
    const ctx = new Proxy({ measureText: (t: string) => ({ width: t.length * 6 }), font: "" } as any,
      { get(o, k) { if (k in o) return typeof o[k] === "function" ? o[k].bind(o) : o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
    F.drawPart(ctx, part, 1, 0, 0, 1234, false, null, { pal: { ...K.DEFAULT_PAL }, mode: "light", labels: { areas: {} } }, false, null, []);
    return { me: calls.get("example-agent"), other: calls.get("general") };
  }
  it("the picked pose on that person only, keyed to restart from its first frame", () => {
    const d = drawn("idle", { name: "example-agent", pose: "pat", t0: 42 });
    expect(d.me.look).toMatchObject({ pose: "pat", basePose: "idle", clip: "#42" });
    expect(d.other.look.pose).toBe("idle");
    expect(drawn("idle", { name: "example-agent", pose: "walkDown", t0: 1 }).me.look).toMatchObject({ pose: "walk", heading: { dx: 0, dy: 1 } });
    expect(drawn("idle", null).me.look.pose).toBe("idle");
  });
  it("never over a call: a caller is drawn calling, preview or not", () => {
    for (const state of ["needs", "crashed", "stuck"]) {
      const d = drawn(state, { name: "example-agent", pose: "idle", t0: 1 });
      expect(d.me.look.clip, state).toBeUndefined();
      expect(d.me.look.pose, state).not.toBe("idle");
    }
  });
});
