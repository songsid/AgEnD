import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

/**
 * "Restart AgEnD" gave no feedback: the restart really happened, but the button stayed pressable, the
 * panel said "restart AgEnD to apply" while it was restarting, and nothing polled — so people pressed
 * it again. The cause was one line: the click handed the *stale* job (finished, "restart-required") to
 * the watcher, whose loop only runs while a job is "running", so it returned at once and re-drew a
 * fresh enabled button. These run the page's real code (the same slice-and-sandbox approach the
 * status-emoji tests use) against scripted server answers, with the fetch that rejects while the fleet
 * is down.
 */
const html = readFileSync(join(process.cwd(), "src", "ui", "settings.html"), "utf8");

class FakeEl {
  attrs: Record<string, string> = {}; children: Array<FakeEl | string> = []; parent: FakeEl | null = null;
  listeners: Record<string, Array<(ev: unknown) => unknown>> = {};
  disabled = false; className = ""; id = "";
  classes = new Set<string>();
  classList = { add: (c: string) => this.classes.add(c), remove: (c: string) => this.classes.delete(c), toggle: (c: string, on?: boolean) => { if (on === undefined ? !this.classes.has(c) : on) this.classes.add(c); else this.classes.delete(c); } };
  constructor(public tag: string) {}
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); if (k === "disabled") this.disabled = true; }
  addEventListener(type: string, fn: (ev: unknown) => unknown) { (this.listeners[type] ??= []).push(fn); }
  append(...kids: Array<FakeEl | string>) { for (const k of kids) { if (k instanceof FakeEl) k.parent = this; this.children.push(k); } }
  set innerHTML(_v: string) { this.children = []; }
  get textContent(): string { return this.children.map(c => typeof c === "string" ? c : c.textContent).join(""); }
  set textContent(v: string) { this.children = [String(v)]; }
  get isConnected() { return true; }
  closest(sel: string): FakeEl | null { const cls = sel.replace(/^\./, ""); for (let e: FakeEl | null = this; e; e = e.parent) if (e.className.split(" ").includes(cls)) return e; return null; }
  all(pred: (e: FakeEl) => boolean): FakeEl[] { const out: FakeEl[] = []; for (const c of this.children) if (c instanceof FakeEl) { if (pred(c)) out.push(c); out.push(...c.all(pred)); } return out; }
  querySelectorAll(sel: string) { return sel === "button" ? this.all(e => e.tag === "button") : []; }
  click(currentTarget: FakeEl = this) { return Promise.all((this.listeners.click ?? []).map(fn => fn({ currentTarget }))); }
}

const elLine = html.split("\n").find(l => l.includes("const el = (tag, attrs = {}, ...kids) =>"))!;
const slice = (from: string, to: string) => { const a = html.indexOf(from); const b = html.indexOf(to, a); expect(a, from).toBeGreaterThan(-1); expect(b, to).toBeGreaterThan(a); return html.slice(a, b); };

type Answer = { ok: boolean; status: number; body: any } | "down";
function panel(script: (path: string, method: string) => Answer | Promise<Answer>) {
  const byId = new Map<string, FakeEl>();
  const $ = (id: string) => { if (!byId.has(id)) { const e = new FakeEl("div"); e.id = id; byId.set(id, e); } return byId.get(id)!; };
  const calls: Array<{ path: string; method: string }> = [];
  const banners: Array<{ text: string; error: boolean }> = [];
  const confirms: string[] = [];
  let reloads = 0;
  const api = async (path: string, opts: { method?: string } = {}) => {
    const method = opts.method ?? "GET";
    calls.push({ path, method });
    const answer = await script(path, method);
    if (answer === "down") throw new TypeError("Failed to fetch");   // what fetch does while the server is restarting
    return answer;
  };
  const t = (k: string) => k;
  const tf = (k: string, ...a: unknown[]) => `${k}(${a.join(",")})`;
  const sandbox: Record<string, unknown> = {
    document: { createElement: (tag: string) => new FakeEl(tag) }, $, api, t, tf,
    state: { schema: {}, fleet: {}, pending: new Map() },
    showBanner: (text: string, error = false) => banners.push({ text, error }),
    confirm: (m: string) => { confirms.push(m); return true; },
    crypto: { randomUUID: () => `key-${calls.length}-${Math.random().toString(36).slice(2)}` },
    setTimeout: (fn: () => void) => { fn(); return 0; },   // a poll's one-second wait costs nothing here
    reload: async () => { reloads++; }, shortName: (n: string) => n, alert: () => {},
    reloadLive: async () => {}, BODY: null,
  };
  const src = `${elLine}\n${slice("  function applyRow(row) {", "  const hasOwn =")}\nthis.api_ = { restartFleet, renderApplyJob, watchApplyJob, getRestarting: () => restartingFleet };`;
  vm.runInNewContext(src, sandbox);
  return { $, calls, banners, confirms, reloads: () => reloads, page: sandbox.api_ as { restartFleet(job: unknown, button?: FakeEl): Promise<void>; renderApplyJob(job: unknown): void; watchApplyJob(job: unknown): Promise<void>; getRestarting(): boolean } };
}

const JOB = "11111111-1111-4111-8111-111111111111";
const base = { id: JOB, key: "k", startedAt: 1, deadlineMs: 120000, pid: 1, elapsed_ms: 1000, overdue: false, message: "" };
const restartRequired = { ...base, status: "done", finishedAt: 2, targets: [{ target: "fleet", kind: "restart", status: "restart-required" }] };
const running = { ...base, status: "running", deadlineMs: 300000, targets: [{ target: "fleet", kind: "restart", status: "running" }] };
const settled = { ...base, status: "done", finishedAt: 3, targets: [{ target: "fleet", kind: "restart", status: "done", settled_by: "fleet-restart" }] };
const ok = (body: unknown, status = 200) => ({ ok: true, status, body });

describe("Restart AgEnD gives feedback and cannot be pressed twice", () => {
  it("disables the button and says so the moment it is pressed — before the server has answered", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const p = panel(async (path) => { if (path.endsWith("/restart-fleet")) { await gate; return ok({ job_id: JOB, restarting: true }, 202); } return ok(settled); });
    p.page.renderApplyJob(restartRequired);
    const button = p.$("applyRows").all(e => e.tag === "button")[0]!;
    expect(button.textContent).toBe("restartFleetButton");
    expect(button.disabled).toBe(false);

    const pending = button.click();
    await new Promise(r => setImmediate(r));
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("restartFleetBusy");
    release(); await pending;
  });

  it("presses once: a second press while it is under way neither asks again nor posts again", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const p = panel(async (path) => { if (path.endsWith("/restart-fleet")) { await gate; return ok({ job_id: JOB, restarting: true }, 202); } return ok(settled); });
    p.page.renderApplyJob(restartRequired);
    const button = p.$("applyRows").all(e => e.tag === "button")[0]!;
    const first = button.click();
    await new Promise(r => setImmediate(r));
    await button.click(); await button.click();
    release(); await first;

    expect(p.calls.filter(c => c.path.endsWith("/restart-fleet"))).toHaveLength(1);
    expect(p.confirms).toHaveLength(1);
    expect(p.page.getRestarting()).toBe(false);          // and it is done, so a later restart is possible
  });

  it("watches the job the server moved to 'running', not the finished one it was holding — and keeps waiting while the fleet is down", async () => {
    const answers: Answer[] = [ok(running), ok(running), "down", "down", "down", ok(settled)];
    const p = panel((path) => path.endsWith("/restart-fleet") ? ok({ job_id: JOB, restarting: true }, 202) : (answers.shift() ?? ok(settled)));
    p.page.renderApplyJob(restartRequired);
    const button = p.$("applyRows").all(e => e.tag === "button")[0]!;
    await button.click();

    const gets = p.calls.filter(c => c.method === "GET");
    expect(gets.length).toBeGreaterThanOrEqual(6);        // it polled — through three failed fetches
    expect(gets.every(c => c.path === `/api/settings/apply/${JOB}`)).toBe(true);
    // It ended on the settled job: applied, no stale "restart to apply" and no button.
    expect(p.$("applyTitle").textContent).toBe("applyDone");
    expect(p.$("applyNote").textContent).toBe("");
    expect(p.$("applyRows").all(e => e.tag === "button")).toEqual([]);
    expect(p.banners.map(b => b.text)).toContain("restartFleetStarted");
    expect(p.banners.at(-1)).toEqual({ text: "changesApplied", error: false });
    expect(p.reloads()).toBe(1);                          // the page refreshes itself once AgEnD is back
  });

  it("believes the server's own account of the job: one already settled is shown as applied without waiting", async () => {
    const p = panel((path) => path.endsWith("/restart-fleet") ? ok({ job_id: JOB, restarting: true }, 202) : ok(settled));
    p.page.renderApplyJob(restartRequired);
    await p.$("applyRows").all(e => e.tag === "button")[0]!.click();
    expect(p.calls.filter(c => c.method === "GET")).toHaveLength(1);   // the one fetch that asked, no poll after it
    expect(p.$("applyTitle").textContent).toBe("applyDone");
    expect(p.banners.at(-1)).toEqual({ text: "changesApplied", error: false });
  });

  it("shows 'restarting' — title, note and row — while the job is running, and never 'restart to apply'", async () => {
    const p = panel(() => ok(running));
    p.page.renderApplyJob(running);
    expect(p.$("applyTitle").textContent).toBe("restartFleetTitle");
    expect(p.$("applyNote").textContent).toBe("restartFleetWaiting");
    expect(p.$("applyRows").textContent).toContain("restartFleetTitle");
    expect(p.$("applyRows").textContent).not.toContain("applyRestartNeeded");
    expect(p.$("applyRows").all(e => e.tag === "button")).toEqual([]);
  });

  it("gives the button back, with its own label and the reason, when the server refuses", async () => {
    const p = panel((path) => path.endsWith("/restart-fleet")
      ? { ok: false, status: 429, body: { error: "AgEnD was restarted from Settings very recently", retry_after_seconds: 600 } }
      : ok(restartRequired));
    p.page.renderApplyJob(restartRequired);
    const button = p.$("applyRows").all(e => e.tag === "button")[0]!;
    await button.click();

    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("restartFleetButton");
    expect(p.banners.at(-1)).toEqual({ text: "restartFleetRateLimited(AgEnD was restarted from Settings very recently,10)", error: true });
    expect(p.calls.filter(c => c.method === "GET")).toEqual([]);     // nothing to watch: no restart began
    expect(p.page.getRestarting()).toBe(false);
    await button.click();                                            // a later press can try again
    expect(p.calls.filter(c => c.path.endsWith("/restart-fleet"))).toHaveLength(2);
  });

  it("gives the button back when the request itself cannot be made", async () => {
    const p = panel((path) => path.endsWith("/restart-fleet") ? "down" : ok(restartRequired));
    p.page.renderApplyJob(restartRequired);
    const button = p.$("applyRows").all(e => e.tag === "button")[0]!;
    await button.click();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("restartFleetButton");
    expect(p.banners.at(-1)!.error).toBe(true);
    expect(p.page.getRestarting()).toBe(false);
  });

  it("re-draws a disabled 'restarting' button if the panel is redrawn mid-restart", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const p = panel(async (path) => { if (path.endsWith("/restart-fleet")) { await gate; return ok({ job_id: JOB, restarting: true }, 202); } return ok(settled); });
    p.page.renderApplyJob(restartRequired);
    const pending = p.$("applyRows").all(e => e.tag === "button")[0]!.click();
    await new Promise(r => setImmediate(r));

    p.page.renderApplyJob(restartRequired);              // something else redraws the panel from the stale job
    const redrawn = p.$("applyRows").all(e => e.tag === "button")[0]!;
    expect(redrawn.disabled).toBe(true);
    expect(redrawn.textContent).toBe("restartFleetBusy");
    release(); await pending;
  });
});

describe("Start / Stop / Pause / Wake show that they are working and cannot be repeated", () => {
  function agentPanel(work: (path: string) => Promise<{ ok: boolean; status: number; body: any }>) {
    const calls: string[] = []; const banners: Array<{ text: string; error: boolean }> = []; let reloads = 0;
    const sandbox: Record<string, unknown> = {
      api: async (path: string) => { calls.push(path); return work(path); },
      t: (k: string) => k, tf: (k: string, ...a: unknown[]) => `${k}(${a.join(",")})`,
      showBanner: (text: string, error = false) => banners.push({ text, error }),
      setTimeout: (fn: () => void) => { fn(); return 0; },
      reloadLive: async () => { reloads++; }, alert: () => {},
    };
    vm.runInNewContext(`${slice("  // Start, stop, pause and wake take a moment", "  async function delAgent")}\nthis.fns = { toggleAgent, pauseWakeAgent };`, sandbox);
    const item = new FakeEl("div"); item.className = "item";
    const mk = (label: string) => { const b = new FakeEl("button"); b.children = [label]; item.append(b); return b; };
    return { fns: sandbox.fns as { toggleAgent(n: string, running: boolean, b?: FakeEl): Promise<void>; pauseWakeAgent(n: string, a: string, b?: FakeEl): Promise<void> }, calls, banners, reloads: () => reloads, item, mk };
  }

  it("disables the row and labels the pressed button while the request is in flight", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const a = agentPanel(async () => { await gate; return { ok: true, status: 200, body: {} }; });
    const settings = a.mk("Settings"); const stop = a.mk("Stop");
    const pending = a.fns.toggleAgent("alpha", true, stop);
    await new Promise(r => setImmediate(r));
    expect(stop.textContent).toBe("working");
    expect(stop.disabled).toBe(true);
    expect(settings.disabled).toBe(true);
    release(); await pending;
    expect(stop.textContent).toBe("Stop");               // restored (the real list is redrawn by reloadLive anyway)
    expect(stop.disabled).toBe(false);
    expect(a.reloads()).toBe(1);
  });

  it("sends one request per agent at a time, however often it is pressed", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const a = agentPanel(async () => { await gate; return { ok: true, status: 200, body: {} }; });
    const stop = a.mk("Stop"); const pause = a.mk("Pause");
    const first = a.fns.toggleAgent("alpha", true, stop);
    await new Promise(r => setImmediate(r));
    await a.fns.toggleAgent("alpha", true, stop);
    await a.fns.pauseWakeAgent("alpha", "pause", pause);   // another action on the same agent waits too
    release(); await first;
    expect(a.calls).toEqual(["/stop/alpha"]);
    // ...and a different agent is not held up by it
    await a.fns.toggleAgent("beta", false, a.mk("Start"));
    expect(a.calls).toEqual(["/stop/alpha", "/api/instance/beta/start"]);
  });

  it("says when it failed instead of failing silently, and always frees the agent", async () => {
    const a = agentPanel(async () => ({ ok: false, status: 409, body: { error: "not running" } }));
    const stop = a.mk("Stop");
    await a.fns.toggleAgent("alpha", true, stop);
    expect(a.banners.at(-1)).toEqual({ text: "actionFailed(stop): not running", error: true });
    expect(stop.disabled).toBe(false);
    await a.fns.toggleAgent("alpha", true, stop);           // freed: can be tried again
    expect(a.calls).toEqual(["/stop/alpha", "/stop/alpha"]);
  });

  it("frees the agent even if the request throws", async () => {
    let n = 0;
    const a = agentPanel(async () => { if (n++ === 0) throw new TypeError("Failed to fetch"); return { ok: true, status: 200, body: {} }; });
    const stop = a.mk("Stop");
    await expect(a.fns.toggleAgent("alpha", true, stop)).rejects.toThrow("Failed to fetch");
    expect(stop.disabled).toBe(false);
    await a.fns.toggleAgent("alpha", true, stop);
    expect(a.calls).toHaveLength(2);
  });
});
