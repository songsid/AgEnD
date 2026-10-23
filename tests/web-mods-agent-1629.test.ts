/**
 * #1629 r4 §4 / §7.5 (r4-5b): an agent and mods — export_web_mod and propose_web_mod.
 * - Export: only the caller's own look (theme and pictures, its own card text, the widgets it placed), never custom CSS
 *   or the sidebar, never another instance; what it writes passes the importer's check; a large one comes in parts.
 * - Propose: checked whole; anything carrying custom CSS is refused by the path it came in by (owner_css_not_from_agent),
 *   also when a stored proposal is opened; it counts as an upload; the fleet switch and a lock refuse it; one per agent.
 *   A person opens it into the usual review; once installed (or dismissed) it is gone.
 * - Wiring: no target in either schema, worker, standard and general profiles (#2132), IPC and agent-endpoint ops, the real Daemon
 *   branch (parts both ways, every IPC message < 1 MiB), `agend-agent mod export|propose`.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => { throw new Error(`mods agent: no child process may start (${name})`); };
  return { ...real, spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), exec: refuse("exec"), execSync: refuse("execSync"),
    execFile: refuse("execFile"), execFileSync: refuse("execFileSync"), fork: refuse("fork") };
});

const B = await import("../src/web-mod-bundle.js");
const { AgentMods, MOD_INLINE_BYTES } = await import("../src/web-mod-agent.js");
const { ModStore } = await import("../src/web-mod-store.js");
const { ThemeStore } = await import("../src/web-theme-store.js");
const { WebPrefsStore, OPERATOR } = await import("../src/web-prefs.js");
const { OwnerCssStore } = await import("../src/web-owner-css-store.js");
const { AppearanceLimiter } = await import("../src/web-appearance-policy.js");
const { effectiveAppearanceLimits } = await import("../src/web-appearance-limits.js");
const { checkWidgetSpec } = await import("../src/web-widget.js");

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-mods-agent-")); dirs.push(d); return d; };

const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(w: number, h: number, row: (y: number) => Buffer): Buffer {
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  const raw = Buffer.concat(Array.from({ length: h }, (_, y) => Buffer.concat([Buffer.from([0]), row(y)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const solid = (w: number, h: number, rgb: number[]) => png(w, h, () => Buffer.alloc(w * 3, Buffer.from(rgb)));
/** ~470 KB that doesn't compress: an exported bundle with it is over the inline size. */
const noisy = () => png(400, 390, () => randomBytes(1200));
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const file = (b: Uint8Array | string) => { const bytes = Buffer.from(b); return { sha256: sha(bytes), b64: bytes.toString("base64") }; };
const HEADER = { v: 1, title: "Build", items: [{ type: "progress", label: "Tests", key: "tests" }] };
const limits = effectiveAppearanceLimits(undefined).limits;
const ctx = () => ({ agendVersion: "2.3.0", limits, effects: null });

function setup(opts: { agentEdit?: boolean } = {}) {
  const dir = tmp();
  let clock = 1_000_000;
  const themes = new ThemeStore(dir);
  const prefs = new WebPrefsStore(dir, { exists: () => true } as never);
  const css = new OwnerCssStore(dir, prefs);
  const mods = new ModStore(dir, { themes, prefs, ownerCss: css, effects: null, context: ctx, isKnownInstance: n => n === "alpha" || n === "beta", prefsIdentity: OPERATOR, clock: () => clock });
  const limiter = new AppearanceLimiter(() => clock);
  const notices: Array<[string, string]> = [];
  let changed = 0;
  const web = { themes: { agent_edit: opts.agentEdit ?? true } };
  const agent = new AgentMods({ themes, mods, limiter, webConfig: () => web, context: ctx, notice: (i, t) => notices.push([i, t]), changed: () => { changed++; }, clock: () => clock });
  return { dir, themes, prefs, css, mods, limiter, agent, notices, web, changed: () => changed, tick: (ms: number) => { clock += ms; } };
}
/** An instance's look: a theme with a background, its own card text, an agent widget and a person's widget. */
function dress(s: ReturnType<typeof setup>, name = "alpha", background = solid(8, 8, [10, 20, 30])) {
  const bg = s.themes.addAsset(name, "background", background);
  if (!bg.ok) throw new Error("asset");
  s.themes.setTheme(name, { v: 1, accent: "#8b5cf6", background: { image: bg.id, fit: "cover", opacity: 0.5 }, card: { tagline: "Mine", bio: "My bio" } }, "agent");
  const spec = (checkWidgetSpec(HEADER, "chat_header") as { value: any }).value;
  s.themes.setWidget(name, "chat_header", spec, { tests: 5 }, "agent");
  s.themes.setWidget(name, "details", (checkWidgetSpec({ v: 1, title: "Person's", items: [{ type: "text", key: "t" }] }, "details") as { value: any }).value, { t: "hi" }, "human");
}

describe("export_web_mod", () => {
  it("the caller's own look only: theme and picture, its card text, the widgets it placed — no custom CSS, no sidebar; it imports", () => {
    const s = setup();
    dress(s);
    dress(s, "beta", solid(8, 8, [99, 99, 99]));
    s.prefs.write(OPERATOR, new Map([["widget.sidebar", { spec: { v: 1, title: "Mine", items: [{ type: "stat", label: "Idle", bind: "fleet.idle" }] }, data: {} }]]));
    expect(s.css.save("person:operator", "a { color: red }").ok).toBe(true);
    const r = s.agent.handle("alpha", "export_web_mod", { name: "alpha-look", version: "1.2.3" }) as any;
    expect(r.files.map((f: any) => f.name)).toEqual(["alpha-look-1.2.3.agendmod.json"]);
    const text = Buffer.from(r.files[0].data_b64, "base64").toString("utf8");
    const doc = JSON.parse(text);
    expect(doc.manifest).toMatchObject({ name: "alpha-look", version: "1.2.3", title: "alpha-look", contents: { theme: "theme.json", identity: "identity.json", widgets: { chat_header: "widgets/chat-header.json" } } });
    expect(Object.keys(doc.manifest.contents)).not.toContain("ownerCss");
    expect(Object.keys(doc.files).sort()).toEqual(["identity.json", "pictures/background.png", "theme.json", "widgets/chat-header.json"]);
    expect(text).not.toContain("Person's");                                        // a person's widget is theirs
    expect(Buffer.from(doc.files["pictures/background.png"].b64, "base64").equals(s.themes.asset("alpha", s.themes.get("alpha").theme.background!.image)!.bytes)).toBe(true);
    const back = B.checkModBundle(text, ctx());
    expect(back.ok, JSON.stringify(!back.ok && back.problems)).toBe(true);
    if (back.ok) expect([back.mod.identity, back.mod.theme!.theme.accent, back.mod.widgets.chat_header?.data]).toEqual([{ tagline: "Mine", bio: "My bio" }, "#8b5cf6", { tests: 5 }]);
  });
  it("nothing of its own: nothing_to_export; bad name, version or title: refused", () => {
    const s = setup();
    expect(s.agent.handle("alpha", "export_web_mod", { name: "x", version: "1.0.0" })).toMatchObject({ error: "nothing_to_export" });
    expect(s.agent.handle("alpha", "export_web_mod", { name: "Bad!", version: "1.0.0" })).toMatchObject({ error: "name" });
    expect(s.agent.handle("alpha", "export_web_mod", { name: "x", version: "1" })).toMatchObject({ error: "version" });
    expect(s.agent.handle("alpha", "export_web_mod", { name: "x", version: "1.0.0", title: "t".repeat(61) })).toMatchObject({ error: "title" });
    expect(s.agent.handle("alpha", "export_web_mod", { name: "x", version: "1.0.0", title: "\u034f" }), "the importer's title rule").toMatchObject({ error: "title" });
  });
  it("a large one comes in parts: its own transfer only, indices in range, gone when idle (monotonic)", () => {
    const s = setup();
    dress(s, "alpha", noisy());
    const first = s.agent.handle("alpha", "export_web_mod", { name: "big", version: "1.0.0" }) as any;
    expect(typeof first.transfer).toBe("string");
    const f = first.files[0];
    expect(f.bytes).toBeGreaterThan(MOD_INLINE_BYTES);
    const parts = Array.from({ length: f.parts }, (_, index) => s.agent.handle("alpha", "export_web_mod", { part: { transfer: first.transfer, name: f.name, index } }) as any);
    const data = Buffer.concat(parts.map(p => Buffer.from(p.data_b64, "base64")));
    expect([data.length, sha(data)]).toEqual([f.bytes, f.sha256]);
    expect(s.agent.handle("beta", "export_web_mod", { part: { transfer: first.transfer, name: f.name, index: 0 } })).toMatchObject({ error: "export" });
    expect(s.agent.handle("alpha", "export_web_mod", { part: { transfer: "0".repeat(16), name: f.name, index: 0 } }), "its own, by id").toMatchObject({ error: "export" });
    expect(s.agent.handle("alpha", "export_web_mod", { part: { transfer: first.transfer, name: "other-1.0.0.agendmod.json", index: 0 } }), "and by name").toMatchObject({ error: "export" });
    expect(s.agent.handle("alpha", "export_web_mod", { part: { transfer: first.transfer, name: f.name, index: f.parts } })).toMatchObject({ error: "part" });
    s.tick(60_001);
    expect(s.agent.handle("alpha", "export_web_mod", { part: { transfer: first.transfer, name: f.name, index: 0 } })).toMatchObject({ error: "export" });
  });
});

/** A bundle as an agent might write it. */
function bundle(over: { contents?: Record<string, unknown>; files?: Record<string, unknown>; name?: string } = {}) {
  return JSON.stringify({ format: "agend-mod", v: 1, manifest: { name: over.name ?? "proposed", version: "1.0.0", title: "Proposed look", contents: { identity: "identity.json", ...over.contents } },
    files: { "identity.json": file(JSON.stringify({ tagline: "Hello" })), ...over.files } });
}
const propose = (s: ReturnType<typeof setup>, text: string, who = "alpha") => s.agent.handle(who, "propose_web_mod", { data_b64: Buffer.from(text).toString("base64") }) as any;

describe("propose_web_mod", () => {
  it("checked whole and kept for a person: a notice in its chat, an upload counted; nothing changes yet", () => {
    const s = setup();
    const r = propose(s, bundle());
    expect(r).toMatchObject({ proposed: { name: "proposed", version: "1.0.0", title: "Proposed look" } });
    expect(s.mods.proposals()).toMatchObject([{ instance: "alpha", name: "proposed", title: "Proposed look" }]);
    expect(s.notices).toEqual([["alpha", "Proposed a mod: Proposed look (proposed 1.0.0). A person can review it in Settings → Look → Mods."]]);
    // The user's decision (2026-10-18): a proposal is not counted (no upload budget); nor is it a change.
    expect([s.limiter.remaining("alpha"), s.changed(), s.themes.get("alpha").theme]).toEqual([{ changes: 10, retry_after_s: 0, widget_data: 180, widget_data_retry_after_s: 0 }, 1, { v: 1 }]);
  });
  it("custom CSS from an agent is refused by the path it came in by — before anything else is read, and nothing counts", () => {
    const s = setup();
    const css = bundle({ contents: { ownerCss: { css: "c.css" } }, files: { "c.css": file("a{}") } });
    expect(propose(s, css)).toMatchObject({ error: "owner_css_not_from_agent" });
    expect(propose(s, JSON.stringify({ ...JSON.parse(css), v: 7 })), "even with the file otherwise invalid").toMatchObject({ error: "owner_css_not_from_agent" });
    expect([s.mods.proposals(), s.limiter.remaining("alpha").changes]).toEqual([[], 10]);
  });
  it("an invalid file: its problems, nothing kept, nothing counted", () => {
    const s = setup();
    expect(propose(s, bundle({ files: { "extra.txt": file("x") } }))).toMatchObject({ error: "mod_invalid", errors: [{ path: "files.extra.txt" }] });
    expect(propose(s, "\xff\xfe")).toMatchObject({ error: "mod_invalid" });
    expect([s.mods.proposals(), s.limiter.remaining("alpha").changes]).toEqual([[], 10]);
  });
  it("the fleet switch and a person's lock refuse it; proposals are not counted (the user's decision)", () => {
    const s = setup({ agentEdit: false });
    expect(propose(s, bundle())).toMatchObject({ error: "theme_editing_off" });
    s.web.themes.agent_edit = true;
    s.themes.setLocked("alpha", true);
    expect(propose(s, bundle())).toMatchObject({ error: "locked" });
    s.themes.setLocked("alpha", false);
    for (let i = 0; i < 5; i++) expect(propose(s, bundle({ name: `p${i}` })), `proposal ${i + 1}`).toHaveProperty("proposed");
    expect(s.mods.proposals().map(p => p.name), "one per agent: the newest").toEqual(["p4"]);
    expect(propose(s, bundle({ name: "theirs" }), "beta")).toHaveProperty("proposed");
    expect(s.mods.proposals().map(p => [p.instance, p.name]), "another agent's stays").toEqual([["alpha", "p4"], ["beta", "theirs"]]);
  });
  it("in parts: the same checks, at the first part and at the end", () => {
    const s = setup();
    const big = bundle({ contents: { theme: "theme.json" }, files: { "theme.json": file(JSON.stringify({ v: 1, background: { image: "bg.png", fit: "cover", opacity: 0.5 } })), "bg.png": file(noisy()) } });
    const bytes = Buffer.from(big);
    const { sendAssetInParts } = { sendAssetInParts: null as never };
    void sendAssetInParts;
    const count = Math.ceil(bytes.length / (360 * 1024));
    expect(count).toBeGreaterThan(1);
    let upload: string | undefined, last: any;
    for (let index = 0; index < count; index++) {
      last = s.agent.handle("alpha", "propose_web_mod", { slot: "mod", data_b64: bytes.subarray(index * 360 * 1024, (index + 1) * 360 * 1024).toString("base64"), part: { index, count, bytes: bytes.length, sha256: sha(bytes), ...(upload ? { upload } : {}) } });
      if (index === 0) upload = last.upload;
    }
    expect(last).toMatchObject({ proposed: { name: "proposed" } });
    expect(s.agent.handle("beta", "propose_web_mod", { data_b64: "AA==", part: { index: 1, count: 2, bytes: 2, sha256: sha("xx"), upload } })).toMatchObject({ error: "upload" });
    // The same agent, a part naming another upload: refused, and its own upload starts over.
    const two = Buffer.alloc(400 * 1024, 1);
    const first = s.agent.handle("alpha", "propose_web_mod", { data_b64: two.subarray(0, 360 * 1024).toString("base64"), part: { index: 0, count: 2, bytes: two.length, sha256: sha(two) } }) as any;
    expect(typeof first.upload).toBe("string");
    expect(s.agent.handle("alpha", "propose_web_mod", { data_b64: two.subarray(360 * 1024).toString("base64"), part: { index: 1, count: 2, bytes: two.length, sha256: sha(two), upload: "f".repeat(16) } })).toMatchObject({ error: "upload" });
  });
  it("a person opens it into the usual review; once installed it is gone; a dismissed one too", () => {
    const s = setup();
    propose(s, bundle());
    const st = s.mods.stageProposal("person:operator", "alpha");
    expect(st).toMatchObject({ ok: true, plan: { mod: { name: "proposed" } } });
    if (!st.ok) return;
    expect(s.mods.commit("person:operator", { stage: st.stage, plan_hash: st.plan_hash, include: { identity: true }, target: "alpha" })).toMatchObject({ ok: true });
    expect([s.mods.proposals(), s.themes.get("alpha").theme.card]).toEqual([[], { tagline: "Hello" }]);
    propose(s, bundle({ name: "second" }), "beta");
    expect(s.mods.dismiss("beta")).toEqual({ ok: true });
    expect([s.mods.proposals(), s.mods.stageProposal("p", "beta")]).toEqual([[], { ok: false, status: 404, error: "no_such_proposal" }]);
  });
  it("a stored proposal that carries custom CSS (a file changed on disk) is still refused when a person opens it", () => {
    const s = setup();
    propose(s, bundle());
    const dir = join(s.dir, "web-mods", "proposals");
    const [name] = require("node:fs").readdirSync(dir) as string[];
    writeFileSync(join(dir, name!), bundle({ contents: { ownerCss: { css: "c.css" } }, files: { "c.css": file("a{}") } }));
    expect(s.mods.stageProposal("p", "alpha")).toMatchObject({ ok: false, error: "owner_css_not_from_agent" });
  });
});

describe("propose in parts: every bound on what an agent sends (#1906 review)", () => {
  const PART = 360 * 1024;
  /** A valid bundle of more than one part (a ~470 KB picture that doesn't compress). */
  function payload(): Buffer {
    const bg = png(400, 390, () => randomBytes(1200));
    const text = bundle({ contents: { theme: "theme.json" }, files: { "theme.json": file(JSON.stringify({ v: 1, background: { image: "bg.png", fit: "cover", opacity: 0.5 } })), "bg.png": file(bg) } });
    return Buffer.from(text);
  }
  const send = (s: ReturnType<typeof setup>, bytes: Buffer, index: number, over: Record<string, unknown> = {}, chunk?: Buffer, upload?: string) =>
    s.agent.handle("alpha", "propose_web_mod", { data_b64: (chunk ?? bytes.subarray(index * PART, (index + 1) * PART)).toString("base64"),
      part: { index, count: Math.ceil(bytes.length / PART), bytes: bytes.length, sha256: sha(bytes), ...(upload ? { upload } : {}), ...over } }) as any;
  it("control: the parts in order make one proposal", () => {
    const s = setup(); const b = payload();
    const first = send(s, b, 0);
    let last = first;
    for (let i = 1; i < Math.ceil(b.length / PART); i++) last = send(s, b, i, {}, undefined, first.upload);
    expect(last).toHaveProperty("proposed");
  });
  it("out of order, or a part of another shape (count, bytes, sha) mid-upload: refused, and the upload starts over", () => {
    for (const over of [{ index: 2 }, { count: 4 }, { bytes: 1 }, { sha256: "0".repeat(64) }]) {
      const s = setup(); const b = payload();
      const first = send(s, b, 0);
      const i = (over as { index?: number }).index ?? 1;
      expect(send(s, b, i, over, b.subarray(PART, 2 * PART), first.upload), JSON.stringify(over)).toMatchObject({ error: "part" });
      expect(send(s, b, 1, {}, undefined, first.upload), "the upload is gone").toMatchObject({ error: "upload" });
      expect(s.mods.proposals()).toEqual([]);
    }
  });
  it("parts that don't add up to the declared sha256: refused, nothing kept, nothing counted", () => {
    const s = setup(); const b = payload();
    const wrong = Buffer.from(b); wrong[wrong.length - 10] ^= 0xff;
    const first = s.agent.handle("alpha", "propose_web_mod", { data_b64: wrong.subarray(0, PART).toString("base64"), part: { index: 0, count: Math.ceil(b.length / PART), bytes: b.length, sha256: sha(b) } }) as any;
    let last: any = first;
    for (let i = 1; i < Math.ceil(b.length / PART); i++) last = s.agent.handle("alpha", "propose_web_mod", { data_b64: wrong.subarray(i * PART, (i + 1) * PART).toString("base64"), part: { index: i, count: Math.ceil(b.length / PART), bytes: b.length, sha256: sha(b), upload: first.upload } });
    expect(last).toMatchObject({ error: "part", message: "The parts do not add up to the declared file." });
    expect([s.mods.proposals(), s.limiter.remaining("alpha").changes]).toEqual([[], 10]);
  });
  it("more bytes than declared, a count that doesn't match the bytes, or over 8 MiB: refused", () => {
    const t = setup(); const b = payload();
    expect(Math.ceil(b.length / PART)).toBeGreaterThan(1);
    const f2 = send(t, b, 0);
    for (let i = 1; i < Math.ceil(b.length / PART) - 1; i++) send(t, b, i, {}, undefined, f2.upload);
    expect(send(t, b, Math.ceil(b.length / PART) - 1, {}, Buffer.alloc(PART, 1), f2.upload)).toMatchObject({ error: "part", message: "more bytes than declared" });
    const u = setup();
    expect(send(u, b, 0, { count: 7 })).toMatchObject({ error: "part", message: "count does not match bytes" });
    const huge = 8 * 1024 * 1024 + 1;
    expect(send(u, b, 0, { bytes: huge, count: Math.ceil(huge / PART) })).toMatchObject({ error: "mod_too_large" });
    expect(u.agent.handle("alpha", "propose_web_mod", { data_b64: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64") })).toMatchObject({ error: "mod_too_large" });
  });
  it("an upload idle over 60 s (monotonic) is gone: start again", () => {
    const s = setup(); const b = payload();
    const first = send(s, b, 0);
    s.tick(60_001);
    expect(send(s, b, 1, {}, undefined, first.upload)).toMatchObject({ error: "upload" });
    const t = setup();
    const f2 = send(t, b, 0);
    t.tick(59_000);
    expect(send(t, b, 1, {}, undefined, f2.upload).error, "control: within 60 s").toBeUndefined();
  });
  it("locked (or the switch turned off) while the parts arrive: the last part is refused; the first part refuses on its own", () => {
    const s = setup(); const b = payload();
    const first = send(s, b, 0);
    for (let i = 1; i < Math.ceil(b.length / PART) - 1; i++) send(s, b, i, {}, undefined, first.upload);
    s.themes.setLocked("alpha", true);
    expect(send(s, b, Math.ceil(b.length / PART) - 1, {}, undefined, first.upload)).toMatchObject({ error: "locked" });
    expect([s.mods.proposals(), s.limiter.remaining("alpha").changes]).toEqual([[], 10]);
    expect(send(s, b, 0), "and a new first part").toMatchObject({ error: "locked" });
    s.themes.setLocked("alpha", false);
    s.web.themes.agent_edit = false;
    expect(send(s, b, 0)).toMatchObject({ error: "theme_editing_off" });
  });
});

describe("proposals: leftovers and bookkeeping (#1906 review)", () => {
  it("installing removes the proposal only when it is that very mod (a file swapped on disk stays proposed)", () => {
    const s = setup();
    propose(s, bundle());
    const dir = join(s.dir, "web-mods", "proposals");
    const [name] = require("node:fs").readdirSync(dir) as string[];
    writeFileSync(join(dir, name!), bundle({ name: "swapped" }));            // another valid mod
    const st = s.mods.stageProposal("p", "alpha");
    if (!st.ok) throw new Error("stage");
    expect(s.mods.commit("p", { stage: st.stage, plan_hash: st.plan_hash, include: { identity: true }, target: "alpha" }).ok).toBe(true);
    expect(s.mods.proposals().map(p => p.name), "the proposal named another mod: it stays").toEqual(["proposed"]);
  });
  it("dismiss deletes the file; a failed index write removes the file just written; removing an instance drops its proposal", () => {
    const s = setup();
    propose(s, bundle());
    const dir = join(s.dir, "web-mods", "proposals");
    expect(require("node:fs").readdirSync(dir)).toHaveLength(1);
    s.mods.dismiss("alpha");
    expect(require("node:fs").readdirSync(dir)).toEqual([]);
    // A failed index write: the file just written goes (none before) …
    const t = setup();
    t.mods.proposals();                                                          // the index is read (and empty)
    mkdirSync(join(t.dir, "web-mods.json"));
    expect(propose(t, bundle()).error).toBe("mods_write_failed");
    expect(require("node:fs").readdirSync(join(t.dir, "web-mods", "proposals")), "no file left behind").toEqual([]);
    // … or the proposal it replaced is put back, and still opens as itself.
    const u = setup();
    propose(u, bundle());
    rmSync(join(u.dir, "web-mods.json")); mkdirSync(join(u.dir, "web-mods.json"));
    expect(propose(u, bundle({ name: "second" })).error).toBe("mods_write_failed");
    const [kept] = require("node:fs").readdirSync(join(u.dir, "web-mods", "proposals")) as string[];
    expect(JSON.parse(readFileSync(join(u.dir, "web-mods", "proposals", kept!), "utf8")).manifest.name, "the first proposal's text, not the failed one").toBe("proposed");
    const v = setup();
    propose(v, bundle());
    v.mods.forgetInstance("alpha");
    expect([v.mods.proposals(), require("node:fs").readdirSync(join(v.dir, "web-mods", "proposals"))]).toEqual([[], []]);
  });
  it("a stored proposal whose id isn't an id is not loaded", () => {
    const s = setup();
    propose(s, bundle());
    const doc = JSON.parse(readFileSync(join(s.dir, "web-mods.json"), "utf8"));
    doc.proposals.alpha.id = "../../x";
    writeFileSync(join(s.dir, "web-mods.json"), JSON.stringify(doc));
    const fresh = new ModStore(s.dir, { themes: s.themes, prefs: s.prefs, ownerCss: s.css, effects: null, context: ctx, isKnownInstance: () => true, prefsIdentity: OPERATOR });
    expect(fresh.proposals()).toEqual([]);
  });
});

describe("wiring", () => {
  it("no target in either schema; worker, standard and general profiles (#2132); IPC and endpoint ops", async () => {
    const schemas = await import("../src/outbound-schemas.js");
    const perms = await import("../src/tool-permissions.js");
    for (const s of [schemas.ExportWebModArgs, schemas.ProposeWebModArgs]) expect(Object.keys(s.shape).filter(k => /instance|target/.test(k))).toEqual([]);
    for (const tool of ["export_web_mod", "propose_web_mod"]) {
      expect([perms.TOOL_PROFILES.worker.includes(tool), perms.TOOL_PROFILES.standard.includes(tool), perms.TOOL_PROFILES.general.includes(tool)], tool).toEqual([true, true, true]);
      expect(Object.values(perms.IPC_TYPE_TOOLS)).toContain(tool);
      expect(Object.values(perms.EARLY_AGENT_OP_TOOLS)).toContain(tool);
    }
    const { TOOLS } = await import("../src/channel/mcp-tools.js");
    expect(TOOLS.map((t: { name: string }) => t.name).filter((n: string) => /import_web_mod|install_web_mod/.test(n)), "agents never import").toEqual([]);
  });
  it.each([false, true])("daemon mod export / propose, IPC < 1 MiB (state workspace=%s)", async classic => {
    const s = setup();
    dress(s, "a", noisy());
    const home = tmp(), ws = classic ? join(home, "workspaces/a") : tmp();
    mkdirSync(ws, { recursive: true }); vi.stubEnv("AGEND_HOME", home);
    const { Daemon } = await import("../src/daemon.js");
    const daemon = new Daemon("a", { working_directory: ws, log_level: "error", restart_policy: { max_retries: 1, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 } } as never, join(ws, ".instance"), true, undefined, undefined, pino({ level: "silent" }) as never) as any;
    const send = vi.fn((_socket: unknown, _msg: unknown) => true);
    const sizes: number[] = [];
    daemon.ipcServer = { send, broadcast: (msg: any) => {
      sizes.push(JSON.stringify(msg).length);
      const result = s.agent.handle(msg.meta.instance_name, msg.type.replace(/^fleet_/, ""), msg.payload);
      setImmediate(() => { sizes.push(JSON.stringify({ result }).length); daemon.pendingIpcRequests.get(msg.fleetRequestId)?.({ result }); });
    } };
    daemon.handleToolCall({ tool: "export_web_mod", args: { name: "mine", version: "1.0.0" }, requestId: 1 }, {} as never);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { timeout: 20_000 });
    const path = join(ws, ".agend", "mods", "mine-1.0.0.agendmod.json");
    expect((send.mock.calls[0]![1] as any).result).toMatchObject({ path, bytes: expect.any(Number) });
    const text = readFileSync(path, "utf8");
    expect(B.checkModBundle(text, ctx()).ok).toBe(true);
    // Propose that same file back (from the working directory, in parts).
    writeFileSync(join(ws, "again.agendmod.json"), text.replace('"name":"mine"', '"name":"again"'));
    daemon.handleToolCall({ tool: "propose_web_mod", args: { file: "again.agendmod.json" }, requestId: 2 }, {} as never);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), { timeout: 20_000 });
    expect((send.mock.calls[1]![1] as any).result).toMatchObject({ proposed: { name: "again" } });
    expect(Math.max(...sizes)).toBeLessThan(1024 * 1024);
  }, 60_000);
  it.each([false, true])("agend-agent mod export / propose (state workspace=%s)", async classic => {
    const { createServer } = await import("node:http");
    const { execFile } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { pathToFileURL } = await import("node:url");
    const s = setup();
    dress(s, "a");
    const ops: string[] = [];
    const server = createServer((req, res) => { let body = ""; req.on("data", c => { body += c; }); req.on("end", () => {
      const p = JSON.parse(body); ops.push(p.op);
      res.end(JSON.stringify(s.agent.handle("a", p.op === "mod-export" ? "export_web_mod" : "propose_web_mod", p.args)));
    }); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const home = tmp(), ws = classic ? join(home, "workspaces/a") : tmp();
    mkdirSync(ws, { recursive: true });
    const run = (...argv: string[]) => new Promise<string>(resolve => execFile(process.execPath, ["--import", pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href, join(process.cwd(), "src/agent-cli.ts"), ...argv], {
      cwd: ws, env: { ...process.env, AGEND_PORT: String(port), AGEND_INSTANCE_NAME: "a", AGEND_HOME: home }, timeout: 60_000 }, (_e, stdout, stderr) => resolve(stdout + stderr)));
    try {
      const out = JSON.parse(await run("mod", "export", "mine", "1.0.0", "My", "look"));
      expect(out.path).toBe(join(ws, ".agend", "mods", "mine-1.0.0.agendmod.json"));
      expect(JSON.parse(readFileSync(out.path, "utf8")).manifest.title).toBe("My look");
      mkdirSync(join(ws, "m"));
      writeFileSync(join(ws, "m", "p.agendmod.json"), bundle());
      expect(JSON.parse(await run("mod", "propose", "m/p.agendmod.json"))).toMatchObject({ proposed: { name: "proposed" } });
      expect(ops).toEqual(["mod-export", "mod-propose"]);
    } finally { await new Promise(r => server.close(r)); }
  }, 120_000);
});

describe("the page: proposals", () => {
  it("listed by agent; Review opens it into the usual plan; Dismiss drops it; a malformed entry is skipped", async () => {
    const { page, settle } = await import("./helpers/app-harness.js");
    vi.resetModules();
    const pg = page({ url: "http://127.0.0.1:19280/settings/appearance" });
    try {
      const calls: Array<[string, string]> = [];
      const plan = { mod: { id: "a".repeat(32), name: "proposed", version: "1.0.0", title: "Proposed look", bytes: 10, installed: false }, items: [{ part: "identity", tagline: "Hello" }], needs_target: true, warnings: [] };
      vi.stubGlobal("fetch", async (url: string, init: { body?: string } = {}) => {
        calls.push([url, init.body ?? ""]);
        const body = url === "/ui/mods" ? { mods: [], staged: null, proposals: [{ instance: "alpha", name: "proposed", version: "1.0.0", title: "Proposed look" }, { instance: 1 }] }
          : url === "/ui/mods/proposal/stage" ? { stage: "s1", plan, plan_hash: "h" } : { ok: true };
        return { ok: true, status: 200, json: async () => body };
      });
      const P = await import("/assets/app-html.js");
      const { ModsCard } = await import("/ui/js/settings-mods.js");
      P.render(P.h(ModsCard, {}), pg.root); await settle(); await settle();
      const items = [...pg.root.querySelectorAll(".s-mod-proposals li")] as any[];
      expect(items.map(li => li.textContent.replace(/\s+/g, " ").trim())).toEqual(["alpha proposes Proposed look proposed 1.0.0ReviewDismiss"]);
      (items[0].querySelectorAll("button")[0] as any).click(); await settle(); await settle();
      expect(calls.at(-1)).toEqual(["/ui/mods/proposal/stage", JSON.stringify({ instance: "alpha" })]);
      expect(pg.root.querySelector(".s-mod-plan h4")!.textContent).toContain("Proposed look");
    } finally { vi.unstubAllGlobals(); pg.restore(); }
  });
});

describe("the agent's side of a transfer", () => {
  it("a part that doesn't add up is refused; only the mod file name is written, nothing else", async () => {
    const { receiveFiles, writeModFile, MOD_FILE } = await import("../src/web-asset-parts.js");
    const data = Buffer.from("x".repeat(1000));
    const first = { transfer: "t1", files: [{ name: "a-1.0.0.agendmod.json", bytes: data.length, sha256: sha(data), parts: 1 }] };
    expect(await receiveFiles(first, async () => ({ data_b64: Buffer.from("y".repeat(1000)).toString("base64") }), { name: MOD_FILE, idKey: "transfer", what: "export" })).toMatchObject({ error: "export", message: "The export's parts do not add up." });
    expect(await receiveFiles(first, async () => ({ data_b64: data.toString("base64") }), { name: MOD_FILE, idKey: "transfer", what: "export" })).toEqual({ files: [{ name: "a-1.0.0.agendmod.json", data }] });
    const ws = tmp();
    for (const name of ["../x-1.0.0.agendmod.json", "x.json", "X-1.0.0.agendmod.json"]) expect(await writeModFile([{ name, data }], { workspace: ws, stateDir: tmp() }), name).toHaveProperty("error");
    expect(require("node:fs").existsSync(join(ws, ".agend"))).toBe(false);
    expect(await writeModFile([{ name: "ok-1.0.0.agendmod.json", data }], { workspace: ws, stateDir: tmp() })).toEqual({ path: join(ws, ".agend", "mods", "ok-1.0.0.agendmod.json"), bytes: data.length });
  });
});
