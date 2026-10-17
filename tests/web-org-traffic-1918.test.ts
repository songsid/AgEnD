/**
 * #1918 phase 3: live traffic on the org canvas (src/ui/fleet-traffic.js, drawn by fleet-canvas.js).
 * - The store: queued → delivering → delivered (fades FADE_MS, then goes); consumed / failed / uncertain / cancelled end
 *   a line at once; a finished message never comes back; a snapshot ends what it no longer lists.
 * - Edges: one per (from, to, kind, phase), ×N; far = per team pair; a broadcast fans out, bundled per team past
 *   BUNDLE_AT recipients (the user's decision 3); routed through empty lanes — never across a card; at most MAX_EDGES.
 * - The page: the snapshot on opening, then the stream's items; with no live stream (the public link) the snapshot
 *   every POLL_MS while shown (the user's decision 1); Live per device; the list says it in words.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const id = (n: number) => n.toString(16).padStart(16, "0");
const it_ = (n: number, from: string, to: string, state = "queued", kind = "task", extra: Record<string, unknown> = {}) => ({ id: id(n), from, to, kind, state, at: "2026-10-17T10:00:00.000Z", ...extra });

const INSTANCES = [{ name: "atlas", status: "running", backend: "claude-code" },
  ...["pixel", "quill", "sage", "orbit", "nova", "ember", "lark", "moss", "juno", "flint", "wren", "cedar"].map((name) => ({ name, status: "running", backend: "codex" }))];
const ORG = { general: ["atlas"], teams: [{ name: "Platform", members: ["pixel", "quill", "sage", "orbit"] }, { name: "Web", members: ["nova", "ember", "lark", "moss", "juno"] },
  { name: "Research", members: ["flint", "wren"] }], instances: {} };

let p: AppPage;
let T: any, C: any, O: any, app: any, fleet: any, nav: any;
let snapshot: any = { now: "", items: [] };
let reads = 0;
const subs = new Map<string, Set<(d: unknown) => void>>();
const emit = (name: string, d: unknown) => { for (const fn of subs.get(name) ?? []) fn(d); };
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  (globalThis as any).fetch = async (url: string) => {
    if (url === "/ui/traffic") reads++;
    return { ok: true, status: 200, json: async () => (url === "/ui/org" ? ORG : url === "/ui/traffic" ? snapshot : {}) };
  };
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
  fleet = await import("/ui/js/panel-fleet.js");
  T = await import("/ui/js/fleet-traffic.js");
  C = await import("/ui/js/fleet-canvas.js");
  O = await import("/ui/js/fleet-org.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  vi.useRealTimers();
  await p.unmount();
  p.storage.clear(); subs.clear(); reads = 0; snapshot = { now: "", items: [] };
  delete p.document.body.dataset.webTransport;
  app.appStore.set({ ready: true, instances: INSTANCES, exec: {}, awaiting: {}, needs: [], connection: "live",
    streamOn: (name: string, fn: (d: unknown) => void) => { const s = subs.get(name) ?? new Set(); s.add(fn); subs.set(name, s); return () => s.delete(fn); } });
});
afterEach(() => { vi.useRealTimers(); });
const mount = async () => { await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(6); };
const L = (folded = new Set<string>()) => C.canvasLayout(O.buildOrgView(ORG, app.appStore.get()), folded);
const flows = () => p.root.querySelectorAll(".oc-flow").map((e: any) => e.getAttribute("class").replace("oc-flow ", ""));

describe("the store", () => {
  it("checks what it is sent: a 16-hex id, two names, a known kind and state; an op only when it is one", () => {
    expect(T.itemOk(it_(1, "a", "b"))).toEqual({ id: id(1), from: "a", to: "b", kind: "task", state: "queued" });
    expect(T.itemOk(it_(1, "a", "b", "queued", "broadcast", { op: id(9) })).op).toBe(id(9));
    expect("op" in T.itemOk(it_(1, "a", "b", "queued", "broadcast", { op: "nope" }))).toBe(false);
    for (const bad of [null, "x", { ...it_(1, "a", "b"), id: "dlv-1" }, { ...it_(1, "a", "b"), kind: "notice" }, { ...it_(1, "a", "b"), state: "retry_wait" }, { ...it_(1, "a", "") }])
      expect(T.itemOk(bad), JSON.stringify(bad)).toBeNull();
  });
  it("queued → delivering → delivered fades, then goes; a finished message never comes back", () => {
    const s = T.createTrafficStore();
    expect(s.apply(it_(1, "a", "b"), 0)).toBe(true);
    expect(s.apply(it_(1, "a", "b"), 1), "the same state again").toBe(false);
    expect(s.apply(it_(1, "a", "b", "delivering"), 2)).toBe(true);
    expect(s.apply(it_(1, "a", "b", "delivered"), 10)).toBe(true);
    expect(s.items()).toEqual([expect.objectContaining({ id: id(1), state: "delivered", fading: true })]);
    expect(s.apply(it_(1, "a", "b", "delivering"), 11), "late, out of order").toBe(false);
    expect(s.sweep(10 + T.FADE_MS - 1)).toBe(false);
    expect(s.sweep(10 + T.FADE_MS)).toBe(true);
    expect(s.items()).toEqual([]);
    expect(s.apply(it_(1, "a", "b", "queued"), 20), "ended: never again").toBe(false);
  });
  it("consumed, failed, uncertain and cancelled end a line at once", () => {
    const s = T.createTrafficStore();
    ["consumed", "failed", "uncertain", "cancelled"].forEach((st, i) => { s.apply(it_(i, "a", "b", "delivering"), 0); expect(s.apply(it_(i, "a", "b", st), 1), st).toBe(true); });
    expect(s.items()).toEqual([]);
    expect(s.apply(it_(7, "a", "b", "consumed"), 1), "nothing shown changed").toBe(false);
    expect(s.apply(it_(7, "a", "b", "queued"), 2)).toBe(false);
  });
  it("a snapshot: its live items are drawn; a live line it no longer lists has ended; a finished one is not drawn", () => {
    const s = T.createTrafficStore();
    s.apply(it_(1, "a", "b", "delivering"), 0); s.apply(it_(2, "a", "c", "queued"), 0);
    expect(s.load({ items: [it_(2, "a", "c", "delivering"), it_(3, "b", "a", "queued"), it_(4, "c", "a", "delivered"), { junk: 1 }] }, 5)).toBe(true);
    expect(s.items().map((i: any) => [i.id, i.state])).toEqual([[id(2), "delivering"], [id(3), "queued"]]);
    expect(s.apply(it_(1, "a", "b", "delivered"), 6), "missed while away: ended").toBe(false);
    expect(s.apply(it_(4, "c", "a", "queued"), 6), "finished in the snapshot: ended").toBe(false);
    expect(s.load(null, 7)).toBe(true);                                       // nothing in flight any more
    expect(s.items()).toEqual([]);
  });
  it("a snapshot that has a drawn line as delivered starts its fade (the public link has no other news of it); FADE_MS later it goes", () => {
    const s = T.createTrafficStore();
    s.apply(it_(1, "a", "b", "delivering"), 0);
    expect(s.load({ items: [it_(1, "a", "b", "delivered")] }, 100)).toBe(true);
    expect(s.items()).toEqual([expect.objectContaining({ id: id(1), state: "delivered", fading: true })]);
    expect(s.load({ items: [it_(1, "a", "b", "delivered")] }, 200), "the same again: still fading from the first").toBe(false);
    expect(s.sweep(100 + T.FADE_MS - 1)).toBe(false);
    expect(s.sweep(100 + T.FADE_MS)).toBe(true);
    expect(s.items()).toEqual([]);
    // Consumed in the snapshot ends a drawn line at once.
    s.apply(it_(2, "a", "c", "queued"), 300);
    expect(s.load({ items: [it_(2, "a", "c", "consumed")] }, 400)).toBe(true);
    expect(s.items()).toEqual([]);
  });
});

describe("edges", () => {
  it("one line per (from, to, kind, phase), ×N; hues per kind; phases", () => {
    const items = [it_(1, "atlas", "quill"), it_(2, "atlas", "quill"), it_(3, "quill", "atlas", "delivering", "report"), it_(4, "sage", "nova", "delivering", "query"),
      { ...it_(5, "nova", "juno", "delivered", "send"), fading: true }];
    const e = T.trafficEdges(items, L());
    expect(e.map((x: any) => [x.hue, x.phase, x.n, x.names])).toEqual([
      ["report", "live", 1, ["quill", "atlas"]], ["send", "live", 1, ["sage", "nova"]], ["task", "queued", 2, ["atlas", "quill"]], ["send", "fading", 1, ["nova", "juno"]]]);
    expect(e.find((x: any) => x.n === 2).badge).not.toBeNull();
    expect(e.find((x: any) => x.hue === "report").badge).toBeNull();
    expect(T.trafficEdges([it_(1, "atlas", "nobody")], L()), "not on the canvas").toEqual([]);
  });
  it("never across a card: every segment of every route stays out of every card's inside", () => {
    const lay = L();
    const cards = [...lay.tops, ...lay.boxes.flatMap((b: any) => b.cells)];
    const names = cards.map((c: any) => c.node.name);
    let n = 0;
    for (const a of names) for (const b of names) {
      if (a === b) continue;
      for (const e of T.trafficEdges([it_(++n, a, b, "delivering")], lay)) {
        for (let i = 1; i < e.pts.length; i++) {
          const p0 = e.pts[i - 1], p1 = e.pts[i];
          for (const c of cards) {
            // An orthogonal segment crosses a card's inside (1 px in from its border) only if it overlaps it on both axes.
            const x0 = Math.min(p0.x, p1.x), x1 = Math.max(p0.x, p1.x), y0 = Math.min(p0.y, p1.y), y1 = Math.max(p0.y, p1.y);
            const inside = x1 > c.x + 1 && x0 < c.x + c.w - 1 && y1 > c.y + 1 && y0 < c.y + c.h - 1;
            expect(inside, `${a}→${b} segment ${i} crosses ${c.node.name}`).toBe(false);
          }
        }
      }
    }
    expect(n).toBe(names.length * (names.length - 1));
  });
  it("far: one line per team pair, ×N; inside one team, nothing", () => {
    const items = [it_(1, "pixel", "nova"), it_(2, "quill", "ember", "delivering"), it_(3, "pixel", "quill"), it_(4, "atlas", "flint")];
    const e = T.trafficEdges(items, L(), { far: true });
    expect(e.map((x: any) => [x.key, x.n, x.hue])).toEqual([["team|box:Platform>box:Web|live", 2, "team"], ["team|top/atlas>box:Research|live".replace("top/", "\u0000top/"), 1, "team"]]);
    expect(e.map((x: any) => !!x.badge), "×N only when more than one").toEqual([true, false]);
  });
  it("a folded team: its members' lines end at its box, ×N; a line inside it is not drawn", () => {
    const items = [it_(1, "atlas", "nova"), it_(2, "atlas", "juno"), it_(3, "nova", "juno")];
    const e = T.trafficEdges(items, L(new Set(["Web"])));
    expect(e.map((x: any) => [x.key, x.n])).toEqual([["\u0000top/atlas>box:Web|task|queued", 2]]);
  });
  it("a broadcast fans out; past BUNDLE_AT recipients it bundles per recipient team, ×N", () => {
    const op = id(99);
    const small = ["pixel", "quill", "nova"].map((to, i) => it_(i + 1, "atlas", to, "delivering", "broadcast", { op }));
    expect(T.trafficEdges(small, L()).map((x: any) => [x.hue, x.n])).toEqual([["broadcast", 1], ["broadcast", 1], ["broadcast", 1]]);
    const all = ["pixel", "quill", "sage", "orbit", "nova", "ember", "lark", "moss", "juno"].map((to, i) => it_(i + 1, "atlas", to, "delivering", "broadcast", { op }));
    expect(all.length).toBeGreaterThan(T.BUNDLE_AT);
    expect(T.trafficEdges(all, L()).map((x: any) => [x.key, x.n])).toEqual([["broadcast|\u0000top/atlas>box:Platform|live", 4], ["broadcast|\u0000top/atlas>box:Web|live", 5]]);
  });
  it("at most MAX_EDGES lines; live ones first", () => {
    const lay = L(), names = [...lay.tops, ...lay.boxes.flatMap((b: any) => b.cells)].map((c: any) => c.node.name);
    const items: any[] = [];
    let n = 0;
    for (const a of names) for (const b of names) if (a !== b) items.push(it_(++n, a, b, n % 2 ? "queued" : "delivering"));
    const e = T.trafficEdges(items, lay);
    expect(e).toHaveLength(T.MAX_EDGES);
    expect(e.every((x: any) => x.phase === "live")).toBe(true);
  });
  it("sendingBy: live messages per sender, in words for the list", () => {
    const m = T.sendingBy([it_(1, "atlas", "quill"), it_(2, "atlas", "quill"), it_(3, "atlas", "sage", "delivering", "report"), { ...it_(4, "sage", "atlas", "delivered"), fading: true }]);
    expect([...m.keys()]).toEqual(["atlas"]);
    expect(m.get("atlas").map((x: any) => [x.kind, x.to, x.queued])).toEqual([["task", "quill", true], ["report", "sage", false]]);
  });
});

describe("the page", () => {
  it("reads the snapshot on opening, then draws the stream's items as they move; delivered fades, consumed goes", async () => {
    snapshot = { now: "", items: [it_(1, "atlas", "quill", "delivering")] };
    await mount();
    expect(reads).toBe(1);
    expect(flows()).toEqual(["h-task ph-live"]);
    expect(p.root.querySelector(".oc-pulse animateMotion")).not.toBeNull();
    expect(p.root.querySelector(".oc-legend")).not.toBeNull();
    emit("traffic", it_(2, "sage", "atlas", "queued", "report")); await settle(2);
    expect(flows()).toEqual(["h-task ph-live", "h-report ph-queued"]);
    emit("traffic", it_(1, "atlas", "quill", "delivered")); await settle(2);
    expect(flows()).toEqual(["h-report ph-queued", "h-task ph-fading"]);
    emit("traffic", it_(2, "sage", "atlas", "consumed")); await settle(2);
    expect(flows()).toEqual(["h-task ph-fading"]);
    // A line is drawn between the team boxes and the cards.
    const layers = p.root.querySelector(".oc-world").children.map((g: any) => g.getAttribute("class"));
    expect(layers).toEqual(["oc-tree", "oc-teams", "oc-flows", "oc-cards"]);
    expect(reads, "the stream is live: no polling").toBe(1);
  });
  it("the faded line goes after FADE_MS (the sweep)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance"] });
    const m = mount(); await vi.advanceTimersByTimeAsync(50); await m;
    emit("traffic", it_(1, "atlas", "quill", "delivered")); await vi.advanceTimersByTimeAsync(20);
    expect(flows()).toEqual(["h-task ph-fading"]);
    await vi.advanceTimersByTimeAsync(T.FADE_MS + 1100);
    expect(flows()).toEqual([]);
  });
  it("the public link (no stream): the snapshot every POLL_MS while shown; a stream that comes back is read once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance"] });
    p.document.body.dataset.webTransport = "poll";
    const m = mount(); await vi.advanceTimersByTimeAsync(50); await m;
    expect(reads).toBe(1);
    snapshot = { now: "", items: [it_(5, "nova", "juno", "delivering", "send")] };
    await vi.advanceTimersByTimeAsync(T.POLL_MS);
    expect(reads).toBe(2);
    expect(flows()).toEqual(["h-send ph-live"]);
    // Delivered in the next snapshot: the line fades (no stream to say so), then goes.
    snapshot = { now: "", items: [it_(5, "nova", "juno", "delivered", "send")] };
    await vi.advanceTimersByTimeAsync(T.POLL_MS);
    expect(flows()).toEqual(["h-send ph-fading"]);
    await vi.advanceTimersByTimeAsync(T.FADE_MS + 1100);
    expect(flows()).toEqual([]);
    snapshot = { now: "", items: [] };
    const n = reads;
    (p.document as any).hidden = true;
    await vi.advanceTimersByTimeAsync(T.POLL_MS * 3);
    expect(reads, "hidden: no reads").toBe(n);
    (p.document as any).hidden = false;
    delete p.document.body.dataset.webTransport;
    emit("connection", "live"); await vi.advanceTimersByTimeAsync(10);
    expect(reads).toBe(n + 1);
    await vi.advanceTimersByTimeAsync(T.POLL_MS * 2);
    expect(reads, "a live stream: no polling").toBe(n + 1);
    // A stream that fell back to polling /ui/poll (no traffic there): the snapshot again.
    app.appStore.set((s: any) => ({ ...s, connection: "polling" }));
    await vi.advanceTimersByTimeAsync(T.POLL_MS);
    expect(reads).toBe(n + 2);
  });
  it("zoomed out past FAR_K: lines per team pair", async () => {
    await mount();
    emit("traffic", it_(1, "pixel", "nova")); emit("traffic", it_(2, "quill", "ember")); await settle(2);
    expect(flows()).toEqual(["h-task ph-queued", "h-task ph-queued"]);
    const svg = p.root.querySelector(".oc-svg");
    for (let i = 0; i < 6; i++) { svg.dispatchEvent(Object.assign(new (globalThis as any).Event("keydown", { bubbles: true }), { key: "-" })); }
    await settle(2);
    expect(flows()).toEqual(["h-team ph-queued"]);
    expect(p.root.querySelector(".oc-badge text").textContent).toBe("×2");
  });
  it("Live off: no lines, no reads, kept on this device; the list says what each instance is sending", async () => {
    snapshot = { now: "", items: [it_(1, "atlas", "quill", "delivering"), it_(2, "atlas", "sage", "queued", "report")] };
    await mount();
    const live = p.root.querySelector(".oc-live");
    expect(live.getAttribute("aria-pressed")).toBe("true");
    p.root.querySelectorAll(".oc-tools .seg-inline button")[1].click(); await settle(2);
    expect(p.root.querySelector(".org-sending").textContent.replace(/\s+/g, " ").trim()).toBe("Sending: delegate_task → quill, report_result → sage (queued)");
    p.root.querySelector(".oc-live").click(); await settle(2);
    expect(p.root.querySelector(".org-sending")).toBeNull();
    expect(localStorage.getItem("agend_org_live")).toBe("0");
    p.root.querySelectorAll(".oc-tools .seg-inline button")[0].click(); await settle(2);
    expect(flows()).toEqual([]);
    expect(p.root.querySelector(".oc-legend")).toBeNull();
    await p.unmount(); reads = 0; await mount();
    expect([reads, flows().length]).toEqual([0, 0]);
    emit("traffic", it_(3, "atlas", "quill")); await settle(2);
    expect(flows()).toEqual([]);
  });
  it("search dims the lines that do not touch a match", async () => {
    await mount();
    emit("traffic", it_(1, "atlas", "quill")); emit("traffic", it_(2, "sage", "nova", "queued", "send")); await settle(2);
    const input = p.root.querySelector(".oc-find input");
    input.value = "nov"; input.dispatchEvent(Object.assign(new (globalThis as any).Event("input", { bubbles: true }))); await settle(2);
    expect(p.root.querySelectorAll(".oc-fl").map((g: any) => g.getAttribute("class"))).toEqual(["oc-fl dim", "oc-fl"]);
  });
  it("Live turned off while the tab is open lets go of the stream at once; on again subscribes again and reads the snapshot", async () => {
    await mount();
    expect([subs.get("traffic")?.size, reads]).toEqual([1, 1]);
    p.root.querySelector(".oc-live").click(); await settle(2);
    expect([subs.get("traffic")?.size, subs.get("connection")?.size]).toEqual([0, 0]);
    p.root.querySelector(".oc-live").click(); await settle(4);
    expect([subs.get("traffic")?.size, reads]).toEqual([1, 2]);
  });
  it("the key: folded until opened, kept per device; each line starts at a dot and ends at an arrow of its colour", async () => {
    await mount();
    emit("traffic", it_(1, "atlas", "quill", "delivering")); await settle(2);
    const key = p.root.querySelector(".oc-legend");
    expect(!!key.open).toBe(false);
    key.open = true; key.dispatchEvent(Object.assign(new (globalThis as any).Event("toggle"), {}));
    expect(localStorage.getItem("agend_org_key")).toBe("1");
    await p.unmount(); await mount();
    emit("traffic", it_(1, "atlas", "quill", "delivering")); await settle(2);
    expect(!!p.root.querySelector(".oc-legend").open).toBe(true);
    const f = p.root.querySelector(".oc-flow");
    expect([f.getAttribute("marker-start"), f.getAttribute("marker-end")]).toEqual(["url(#oc-src-task)", "url(#oc-ah-task)"]);
    expect(["oc-src-task", "oc-ah-task"].every((id) => !!p.root.querySelector(`#${id}`))).toBe(true);
  });
  it("the stream hands the page its traffic events (app-stream's named events)", async () => {
    const { createStream } = await import("/assets/app-stream.js");
    const handlers = new Map<string, (e: { data: string }) => void>();
    class FakeSource { constructor(public url: string) {} addEventListener(n: string, fn: (e: { data: string }) => void) { handlers.set(n, fn); } close() {} }
    const env = { EventSource: FakeSource, fetch: async () => ({ ok: true, json: async () => ({}) }), setInterval: () => 1, setTimeout: () => 2, clearInterval() {}, clearTimeout() {} };
    const stream = createStream({ mode: "full", env });
    const got: unknown[] = [];
    stream.on("traffic", (d: unknown) => got.push(d));
    stream.start();
    handlers.get("traffic")!({ data: JSON.stringify(it_(1, "atlas", "quill")) });
    expect(got).toEqual([it_(1, "atlas", "quill")]);
    stream.close?.();
  });
  it("leaving the tab lets go of the stream and the timers", async () => {
    await mount();
    expect(subs.get("traffic")?.size).toBe(1);
    await p.unmount();
    expect(subs.get("traffic")?.size).toBe(0);
    expect(subs.get("connection")?.size).toBe(0);
  });
});
