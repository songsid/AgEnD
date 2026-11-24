/**
 * Talking to an agent from the Office without a pop-up (fleet-office-talk.js):
 * - the store: history once, a send shown at once and replaced by the server's copy (clientId), live replies, a failed
 *   send, the reply kept over a head until it is read (recent / advance / skipAll) and the reading modes (readPace);
 * - a pack's `dialogBox.bubble` (page and host);
 * - on the page: the "Talk" picker (the pop-up by default), the dialogue box's line (Enter sends), the side panel, the
 *   reply over the head, the full chat still a click away.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as T from "../src/ui/fleet-office-talk.js";
import * as D from "../src/ui/fleet-office-dialogue.js";
import * as PK from "../src/ui/fleet-office-pack.js";
import { checkSkinUpload } from "../src/web-office-skins.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire, MiniElement } from "./helpers/mini-dom.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const res = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

describe("the talk store (createTalk)", () => {
  it("reads a thread's history once; a send shows at once, then the server's copy replaces it; replies arrive live", async () => {
    const calls: Array<[string, any]> = [];
    const f = vi.fn(async (url: string, o?: any) => {
      calls.push([url, o]);
      if (url.startsWith("/ui/history")) return res({ messages: [
        { boot: "b", id: 1, role: "user", instance: "atlas", text: "earlier", ts: "t1" },
        { boot: "b", id: 2, role: "agent", instance: "atlas", text: "old answer", ts: "t2" },
        { boot: "b", id: 3, role: "status", instance: "atlas", text: "working", ts: "t3" },
      ] });
      return res({ sent: true });
    });
    const talk = T.createTalk({ fetch: f as any, rid: () => "client-0001" });
    const seen: string[] = [];
    talk.subscribe((n) => seen.push(n));
    await talk.open("atlas"); await talk.open("atlas");
    expect(calls.filter(([u]) => u.startsWith("/ui/history"))).toHaveLength(1);
    expect(calls[0]![0]).toBe("/ui/history?instance=atlas&limit=50");
    expect(talk.thread("atlas").msgs.map((m: any) => m.text)).toEqual(["earlier", "old answer"]);       // a status line is not talk
    expect(talk.lastReply("atlas")).toBe("old answer");
    expect(talk.recent("atlas", Date.now())).toBeNull();                                               // history never pops up

    const sent = talk.send("atlas", "  hello there  ");
    expect(talk.thread("atlas").msgs.at(-1)).toMatchObject({ role: "user", text: "hello there", pending: true });
    expect(await sent).toBe(true);
    const post = calls.find(([u]) => u === "/ui/send")!;
    expect(post[1].method).toBe("POST");
    expect(JSON.parse(post[1].body)).toEqual({ instance: "atlas", message: "hello there", clientId: "client-0001" });
    // The server's copy of it (the same clientId) takes its place; the reply comes after it.
    talk.take({ boot: "b", id: 4, role: "user", instance: "atlas", text: "hello there", clientId: "client-0001", ts: "t4" });
    talk.take({ boot: "b", id: 5, role: "agent", instance: "atlas", text: "Hi! **Done.**", ts: "t5" });
    talk.take({ boot: "b", id: 5, role: "agent", instance: "atlas", text: "Hi! **Done.**", ts: "t5" });   // a replay
    talk.take({ boot: "b", id: 6, role: "agent", instance: "quill", text: "not open", ts: "t6" });       // a thread never opened
    expect(talk.thread("atlas").msgs.map((m: any) => [m.role, m.text, !!m.pending])).toEqual([
      ["user", "earlier", false], ["agent", "old answer", false], ["user", "hello there", false], ["agent", "Hi! **Done.**", false]]);
    expect(talk.thread("quill").msgs).toEqual([]);
    const r = talk.recent("atlas")!;
    expect(r.text).toBe("Hi! **Done.**");
    // It stays until read: a click shows it whole, then turns its page, then (the last page) lets it go.
    talk.advance("atlas"); expect(r.pageAt).toBeLessThan(0); expect(talk.recent("atlas")).toBe(r);
    r.whole = true; r.pages = 2; talk.advance("atlas"); expect([r.page, r.whole]).toEqual([1, false]);
    r.whole = true; talk.advance("atlas"); expect(talk.recent("atlas")).toBeNull();
    talk.take({ boot: "b", id: 7, role: "agent", instance: "atlas", text: "again", ts: "t7" });
    talk.skipAll(); expect(talk.recent("atlas")).toBeNull();
    expect(seen.every((n) => n === "atlas")).toBe(true);
    expect(await talk.send("atlas", "   ")).toBe(false);
  });
  it("a refused send stays, marked failed; a file alone reads as a file; a button says its label", async () => {
    const talk = T.createTalk({ fetch: (async (url: string) => (url === "/ui/send" ? res({ error: "nope" }, false) : res({ messages: [] }))) as any });
    await talk.open("atlas");
    expect(await talk.send("atlas", "hi")).toBe(false);
    expect(talk.thread("atlas").msgs[0]).toMatchObject({ text: "hi", pending: false, failed: true });
    expect(T.talkTextOf({ role: "user", text: "", attachments: [{ name: "a.png" }] })).toBe("[a file]");
    expect(T.talkTextOf({ role: "user", text: "internal", click: { label: "Yes" } })).toBe("Yes");
    expect(T.talkTextOf({ role: "status", text: "x" })).toBeNull();
  });
  it("the modes: the pop-up unless one was picked", () => {
    expect(T.TALK_MODES).toEqual(["window", "panel", "box", "bubble"]);
    expect([T.talkModeOf(null), T.talkModeOf("panel"), T.talkModeOf("bogus")]).toEqual(["window", "panel", "window"]);
    expect(T.READ_MODES).toEqual(["click", "auto", "fast"]);
    expect([T.readModeOf(null), T.readModeOf("fast"), T.readModeOf("bogus")]).toEqual(["click", "fast", "click"]);
    expect(T.readPace("click", 50)).toEqual({ cps: 40, wait: Infinity });          // waits for a click
    expect(T.readPace("auto", 0).wait).toBe(1400);
    expect(T.readPace("auto", 10_000).wait).toBe(5000);
    expect(T.readPace("fast", 100)).toEqual({ cps: 200, wait: 450 });
  });
});

describe("the reply over a head (drawReply) and its look in a pack", () => {
  const ctx = () => {
    const calls: Array<[string, any[]]> = [];
    const t: any = { calls, measureText: (s: string) => ({ width: [...String(s)].length * 6 }) };
    return new Proxy(t, { get(o, k) { if (k in o) return o[k]; return (...a: unknown[]) => { calls.push([String(k), a]); }; }, set(o, k, v) { o[k] = v; return true; } });
  };
  it("the name, then a page of six wrapped lines (the rest on later pages, typed out, ▼ once whole); the pack's colours, else light paper", () => {
    const c = ctx();
    const box = T.drawReply(c, 300, 200, "Atlas", "word ".repeat(200), 0, T.replyStyle(null, { mode: "dark" }), null);
    const texts = c.calls.filter(([k]: any) => k === "fillText").map(([, a]: any) => String(a[0]));
    expect(texts[0]).toBe("Atlas");
    expect(texts).toHaveLength(7);
    expect(box.pages).toBeGreaterThan(1);
    const c2 = ctx(), last = T.drawReply(c2, 300, 200, "Atlas", `${"word ".repeat(200)}END`, 0, T.replyStyle(null, null), null, { page: 99, n: Infinity });
    const t2 = c2.calls.filter(([k]: any) => k === "fillText").map(([, a]: any) => String(a[0]));
    expect(t2.join(" ")).toContain("END");                                         // the last page
    expect(t2.at(-1)).toBe("▼");
    expect(last.len).toBeGreaterThan(0);
    const c3 = ctx();
    T.drawReply(c3, 300, 200, "", "abcdefghij", 0, T.replyStyle(null, null), null, { page: 0, n: 3 });
    expect(c3.calls.filter(([k]: any) => k === "fillText").map(([, a]: any) => String(a[0]))).toEqual(["abc"]);   // typing, no ▼ yet
    expect(box.y + box.h).toBeLessThan(200);                                          // over the head, the tail below
    expect(T.replyStyle({ background: "#112233", enter: "fade" }, { mode: "light" })).toMatchObject({ background: "#112233", text: "#1d1d22", enter: "fade" });
    expect(T.replyStyle(null, null).enter).toBe("pop");
  });
  it("a 9-slice frame is drawn instead of the box when it is loaded", () => {
    const c = ctx(), im = { naturalWidth: 24, naturalHeight: 24 };
    T.drawReply(c, 300, 200, "", "ok", 0, T.replyStyle(null, null), { im, slice: 6, k: 1 });
    expect(c.calls.filter(([k]: any) => k === "drawImage").length).toBe(9);
    expect(c.calls.some(([k]: any) => k === "roundRect")).toBe(false);
  });
  it("a pack's dialogBox.bubble: accepted, normalised, its frame one of the pack's pictures", () => {
    const r = PK.checkSkinPack({ ...MANIFEST(), dialogBox: { background: "#2B1D14", bubble: { frame: "ui/bubble.png", background: "#FFFFFF", enter: "fade" } } }) as any;
    expect(r.ok).toBe(true);
    expect(r.pack.dialogBox).toEqual({ background: "#2b1d14", bubble: { frame: "ui/bubble.png", slice: 6, background: "#ffffff", enter: "fade" } });
    expect(PK.packImages(r.pack)).toEqual(expect.arrayContaining(["ui/bubble.png"]));
  });
  it.each([
    [{ dialogBox: { bubble: { enter: "spin" } } }, "dialogBox.bubble.enter: one of pop, fade, none"],
    [{ dialogBox: { bubble: { slice: 4 } } }, "dialogBox.bubble.slice: only with frame"],
    [{ dialogBox: { bubble: { text: "red" } } }, "dialogBox.bubble.text: a colour as #rrggbb"],
    [{ dialogBox: { bubble: { glow: 1 } } }, 'dialogBox.bubble: unknown key "glow"'],
  ])("refused, saying where: %j", (extra, error) => {
    expect(PK.checkSkinPack({ ...MANIFEST(), ...extra })).toEqual({ ok: false, error });
  });
  it("the host checks the bubble's frame as the box's", () => {
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
    const png = (w: number, hh: number) => { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hh, 4); ihdr[8] = 8; ihdr[9] = 6;
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc((w * 4 + 1) * hh))), chunk("IEND", Buffer.alloc(0))]); };
    const b64 = (f: string) => readFileSync(join(FIXTURE, f)).toString("base64");
    const upload = (frame: Buffer, slice = 6) => ({ manifest: { ...MANIFEST(), dialogBox: { bubble: { frame: "ui/bubble.png", slice } } },
      files: { "office_bg.png": b64("office_bg.png"), "fox_idle.png": b64("fox_idle.png"), "ui/bubble.png": frame.toString("base64") } });
    expect(checkSkinUpload(upload(png(48, 48)), "me", 1).ok).toBe(true);
    const err = (b: unknown) => { const r = checkSkinUpload(b, "me", 1); return r.ok ? null : [r.error, r.detail]; };
    expect(err(upload(png(513, 10)))).toEqual(["skin_portrait_dimensions", "dialogBox.bubble.frame: ui/bubble.png is 513×10 px; at most 512×512"]);
    expect(err(upload(png(20, 20), 10))).toEqual(["skin_portrait_dimensions", "dialogBox.bubble.slice: 10 px a side leaves nothing of ui/bubble.png (20×20)"]);
  });
});

const ORG = { version: 1, orgs: [], teams: [], members: [], roles: {} };
const INSTANCES = [
  { name: "atlas", status: "running", backend: "claude-code", model: "sonnet" },
  { name: "quill", status: "running", backend: "claude-code", model: "sonnet" },
];
function fakeCtx() {
  const calls: Array<[string, any[]]> = [];
  const t: any = { calls, measureText: (s: string) => ({ width: [...String(s)].length * 6 }), createPattern: () => ({ pattern: true }),
    getImageData: (_x: number, _y: number, w: number, hh: number) => ({ data: new Uint8ClampedArray(w * hh * 4) }) };
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; return (...a: unknown[]) => { calls.push([String(k), a]); }; }, set(o, k, v) { o[k] = v; return true; } });
}

describe("talking on the page", () => {
  let p: AppPage, app: any, nav: any, fleet: any;
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  const streamOn = (name: string, fn: (d: unknown) => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); return () => listeners.get(name)!.delete(fn); };
  const emit = (name: string, d: unknown) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(d); };
  const proto = MiniElement.prototype as any;
  const sends: any[] = [];
  let nextId = 100;
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
    (globalThis as any).fetch = async (url: string, o?: any) => {
      if (url === "/ui/send") { sends.push(JSON.parse(o.body)); return res({ sent: true }); }
      if (url.startsWith("/ui/history")) return res({ messages: [{ boot: "b", id: 1, role: "agent", instance: "atlas", text: "Earlier reply", ts: new Date().toISOString() }] });
      return res(url === "/ui/org" ? ORG : url === "/ui/offices" ? { rev: 0, offices: [] } : url === "/ui/office-skins" ? { rev: "", packs: [] } : {});
    };
    app = await import("/assets/app-store.js");
    nav = await import("/assets/app-nav.js");
    nav.startRouter(p.window);
    fleet = await import("/ui/js/panel-fleet.js");
  });
  afterAll(async () => { await p.unmount(); p.restore(); delete (globalThis as any).fetch; });
  beforeEach(async () => {
    await p.unmount(); p.storage.clear(); listeners.clear(); sends.length = 0;
    proto.getContext = function () { return (this._ctx ??= fakeCtx()); };
    localStorage.setItem("agend_org_office_skin", "studio");
    nav.navigate("/ui/fleet/org");
    app.appStore.set({ ready: true, instances: INSTANCES, exec: {}, awaiting: {}, needs: [], streamOn });
  });
  afterEach(() => { delete proto.getContext; });
  const office = async () => {
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(6);
    p.root.querySelectorAll(".oc-tools .seg-inline button")[2].click(); await settle(6);
  };
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await settle(2); };
  const picker = () => p.root.querySelector(".oo-talk-mode");
  const pick = async (v: string) => { const s = picker(); s.value = v; fire(s, "change"); await settle(4); };
  const dialogue = () => p.root.querySelector(".oo-dialogue input");
  /** A message to atlas, then a click on the box over the scene: whom the line below talks to. */
  const clickBox = async () => {
    emit("message", { instance: "atlas", role: "user", sender: "Alex", text: "hi", ts: new Date().toISOString() });
    await tick(20);
    p.root.querySelector(".ot-stage .ot-read").click(); await tick(6);
  };
  const type = async (el: any, text: string) => { el.value = text; fire(el, "input"); await settle(2); fire(el, "keydown", { key: "Enter" }); await tick(4); };

  it("the picker is in the bar, the pop-up by default (nothing new on the page until another is picked)", async () => {
    await office();
    expect(picker().value).toBe("window");
    expect([...picker().querySelectorAll("option")].map((o: any) => o.value)).toEqual(["window", "panel", "box", "bubble"]);
    expect(p.root.querySelector(".ot-bar")).toBeNull();
    expect(p.root.querySelector(".ot-panel")).toBeNull();
    expect(p.root.querySelector(".ot-stage")).toBeNull();
  });
  it("dialogue box: laid over the scene (no row under it); who spoke, the line to type in, the full chat a click away", async () => {
    const opened = vi.fn(() => ({ opener: null })), prior = (p.window as any).open; (p.window as any).open = opened;
    p.document.body.dataset.chatWorkspace = "1"; p.document.body.dataset.chatLayoutScope = "example-scope";
    const priorAuth = (globalThis as any).AgendAuth; (globalThis as any).AgendAuth = { sessionEnded: () => false };
    try {
      await office();
      await pick("box");
      expect(dialogue().checked).toBe(true);
      expect(localStorage.getItem("agend_org_office_talk")).toBe("box");
      expect(p.root.querySelector(".ot-stage")).toBeNull();                         // nobody yet: the scene as it was
      await clickBox();
      expect(opened).not.toHaveBeenCalled();                                         // no pop-up
      expect(p.root.querySelector(".oo-stage .ot-stage")).not.toBeNull();            // on the scene...
      expect(p.root.querySelector(".oo-dialogue-canvas")).toBeNull();                // ...not a row under it
      expect(p.root.querySelector(".ot-bar")).toBeNull();
      expect([...p.root.querySelectorAll(".ot-stage .ot-plate")].map((e: any) => e.textContent)).toEqual(["Alex", "atlas"]);
      expect(p.root.querySelector(".ot-said").textContent).toBe("hi");
      const input = () => p.root.querySelector(".ot-stage .ot-input");
      await type(input(), "status please");
      expect(sends).toEqual([expect.objectContaining({ instance: "atlas", message: "status please" })]);
      expect(input().value).toBe("");
      // What was said from here is said by "You".
      emit("message", { instance: "atlas", role: "user", sender: "Example person", text: "status please", ts: new Date().toISOString() });
      await tick(10);
      expect(p.root.querySelector(".ot-heard .ot-plate").textContent).toBe("You");
      p.root.querySelector(".ot-stage .ot-link").click(); await settle(4);
      expect(opened).toHaveBeenCalledTimes(1);
      expect((opened.mock.calls[0] as any)[0]).toBe("/ui/chat/atlas?presentation=popout");
      // x: a reply still awaited stays; once answered, x closes it and the scene is as it was.
      p.root.querySelector(".ot-stage .ot-x").click(); await tick(6);
      expect(p.root.querySelector(".ot-heard")).not.toBeNull();
      emit("message", { instance: "atlas", role: "agent", text: "ok", ts: new Date().toISOString() });
      await tick(6);
      p.root.querySelector(".ot-stage .ot-x").click(); await tick(6);
      expect(p.root.querySelector(".ot-stage")).toBeNull();
    } finally {
      (p.window as any).open = prior; (globalThis as any).AgendAuth = priorAuth;
      delete p.document.body.dataset.chatWorkspace; delete p.document.body.dataset.chatLayoutScope;
    }
  });
  it("dialogue box reads like a visual novel: the whole reply page by page, a cue, each click the rest / next page / close", async () => {
    await office();
    await pick("box");
    emit("message", { instance: "atlas", role: "user", sender: "Alex", text: "tell me everything", ts: new Date().toISOString() });
    const long = `開頭${"長".repeat(600)}結尾在這裡`;
    emit("message", { instance: "atlas", role: "agent", text: long, ts: new Date().toISOString() });
    await tick(10);
    const words = () => p.root.querySelector(".ot-stage .ot-words");
    Object.defineProperty(words(), "clientWidth", { value: 120, configurable: true });   // 20 characters a line at 6 px
    await tick(4);
    expect(p.root.querySelector(".ot-read").getAttribute("aria-label")).toBe("Click: the rest, the next page, or close");
    let seen = "", clicks = 0, cue = false;
    while (p.root.querySelector(".ot-heard") && clicks < 200) {
      seen += words().textContent; cue = cue || words().textContent.includes("▼");
      p.root.querySelector(".ot-read").click(); await tick(2);
      clicks++;
    }
    expect(p.root.querySelector(".ot-heard")).toBeNull();                            // the last page clicked: closed
    expect(seen).toContain("開頭");
    expect(seen).toContain("結尾在這裡");                                            // the whole reply, not its first 120 characters
    expect(cue).toBe(true);
    expect(clicks).toBeGreaterThan(10);                                               // page by page
  });
  it("the reading controls: Click by default, kept per browser; Fast plays the box on by itself; Skip closes every reply", async () => {
    await office();
    await pick("box");
    emit("message", { instance: "atlas", role: "user", sender: "Alex", text: "q", ts: new Date().toISOString() });
    emit("message", { instance: "atlas", role: "agent", text: "an answer", ts: new Date().toISOString() });
    await tick(10);
    const tools = () => [...p.root.querySelectorAll(".ot-stage .ot-tool")];
    expect(tools().slice(0, 3).map((b: any) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([["Click", "true"], ["Auto", "false"], ["Fast", "false"]]);
    tools()[3].click(); await tick(6);                                                // Skip
    expect(p.root.querySelector(".ot-heard")).toBeNull();
    emit("message", { instance: "atlas", role: "user", sender: "Alex", text: "q2", ts: new Date().toISOString() });
    emit("message", { instance: "atlas", role: "agent", text: "ok", ts: new Date().toISOString() });
    await tick(6);
    tools()[2].click(); await settle(2);                                              // Fast
    expect(localStorage.getItem("agend_org_office_talk_read")).toBe("fast");
    for (let i = 0; i < 40 && p.root.querySelector(".ot-heard"); i++) await new Promise((r) => setTimeout(r, 50)).then(() => tick(2));
    expect(p.root.querySelector(".ot-heard")).toBeNull();                            // played and closed by itself
  });
  it("the store keeps the whole line and holds an answer until it is clicked away", () => {
    const d = D.createDialogue();
    d.heard("atlas", { name: "A" }, "x".repeat(500), 0);
    const c = d.answered("atlas", `${"y".repeat(500)}end`, 10)!;
    expect(c.reply.length).toBeLessThanOrEqual(D.DLG.TEXT_MAX);
    expect(c.replyFull.endsWith("end")).toBe(true);
    D.stageOf(c, 20, false, false);                                 // shown
    expect(d.sweep(20 + D.DLG.HOLD_MS + D.DLG.FADE_MS + 1, false, true)).toBe(false);
    expect(d.size()).toBe(1);
    d.drop("atlas");
    expect(d.size()).toBe(0);
  });
  it("side panel: the conversation beside the map; Shift+Enter is a new line; closing it", async () => {
    await office();
    await pick("box"); await clickBox();
    await pick("panel");
    const panel = p.root.querySelector(".ot-panel");
    expect(panel).not.toBeNull();
    // One way at a time: the dialogue box is not under the panel (its checkbox stays as it was).
    expect(p.root.querySelector(".oo-dialogue-canvas")).toBeNull();
    expect(p.root.querySelector(".ot-bar")).toBeNull();
    expect(p.root.querySelector(".ot-stage")).toBeNull();
    expect(dialogue().checked).toBe(true);
    expect(p.root.querySelector(".oo").className).toContain("ot-side");
    expect(panel.querySelector(".ot-head").textContent).toContain("atlas");
    expect(panel.querySelector(".ot-md").innerHTML).toContain("Earlier reply");
    const input = panel.querySelector(".ot-input");
    input.value = "line one"; fire(input, "input"); await settle(2);
    fire(input, "keydown", { key: "Enter", shiftKey: true }); await settle(2);
    expect(sends).toHaveLength(0);
    fire(input, "keydown", { key: "Enter" }); await tick(4);
    expect(sends.map((s) => s.message)).toEqual(["line one"]);
    expect(p.root.querySelector(".ot-msg.me").textContent).toContain("line one");
    // A live reply lands in the panel, rendered as markdown (escaped first).
    emit("message", { boot: "b", id: nextId++, instance: "atlas", role: "agent", text: "**bold** <script>x</script>", ts: new Date().toISOString() });
    await tick(4);
    const last = [...p.root.querySelectorAll(".ot-msg.agent .ot-md")].at(-1) as any;
    expect(last.innerHTML).toContain("<strong>bold</strong>");
    expect(last.innerHTML).not.toContain("<script>");
    p.root.querySelector(".ot-panel .ot-close").click(); await settle(4);
    expect(p.root.querySelector(".ot-panel")).toBeNull();
  });
  it("over their head: no dock; the reply is drawn over the agent on the map", async () => {
    await office();
    fire(dialogue(), "change"); await settle(4);
    await pick("box"); await clickBox();
    await pick("bubble");
    expect(p.root.querySelector(".oo-dialogue-canvas")).toBeNull();
    expect(p.root.querySelector(".ot-bar")).not.toBeNull();
    emit("message", { boot: "b", id: nextId++, instance: "atlas", role: "agent", text: "On my way to the docs", ts: new Date().toISOString() });
    const drawn = () => (p.root.querySelector(".oo-canvas")._ctx?.calls ?? []).filter(([k]: any) => k === "fillText").map(([, a]: any) => String(a[0]));
    for (let i = 0; i < 40 && !drawn().includes("On my way to the docs"); i++) await new Promise((r) => setTimeout(r, 50)).then(() => tick(2));   // typed out
    expect(drawn()).toEqual(expect.arrayContaining(["On my way to the docs", "▼"]));
  });
});
