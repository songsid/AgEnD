/**
 * #1629 r4 §4 / §7.5 (r4-5b): an agent and mods — export_web_mod and propose_web_mod.
 * - Export: only the caller's own look (theme and pictures, its own card text, the widgets it placed), never custom CSS
 *   or the sidebar, never another instance; what it writes passes the importer's check; a large one comes in parts.
 * - Propose: checked whole; anything carrying custom CSS is refused by the path it came in by (owner_css_not_from_agent),
 *   also when a stored proposal is opened; it counts as an upload; the fleet switch and a lock refuse it; one per agent.
 *   A person opens it into the usual review; once installed (or dismissed) it is gone.
 * - Wiring: no target in either schema, worker and standard profiles only, IPC and agent-endpoint ops, the real Daemon
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
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
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
    expect(s.notices).toEqual([["alpha", "Proposed a mod: Proposed look (proposed 1.0.0). A person can review it in Settings → Appearance → Mods."]]);
    expect([s.limiter.remaining("alpha").uploads, s.changed(), s.themes.get("alpha").theme]).toEqual([2, 1, { v: 1 }]);
  });
  it("custom CSS from an agent is refused by the path it came in by — before anything else is read, and nothing counts", () => {
    const s = setup();
    const css = bundle({ contents: { ownerCss: { css: "c.css" } }, files: { "c.css": file("a{}") } });
    expect(propose(s, css)).toMatchObject({ error: "owner_css_not_from_agent" });
    expect(propose(s, JSON.stringify({ ...JSON.parse(css), v: 7 })), "even with the file otherwise invalid").toMatchObject({ error: "owner_css_not_from_agent" });
    expect([s.mods.proposals(), s.limiter.remaining("alpha").uploads]).toEqual([[], 3]);
  });
  it("an invalid file: its problems, nothing kept, nothing counted", () => {
    const s = setup();
    expect(propose(s, bundle({ files: { "extra.txt": file("x") } }))).toMatchObject({ error: "mod_invalid", errors: [{ path: "files.extra.txt" }] });
    expect(propose(s, "\xff\xfe")).toMatchObject({ error: "mod_invalid" });
    expect([s.mods.proposals(), s.limiter.remaining("alpha").uploads]).toEqual([[], 3]);
  });
  it("the fleet switch, a person's lock and the upload limit refuse it", () => {
    const s = setup({ agentEdit: false });
    expect(propose(s, bundle())).toMatchObject({ error: "theme_editing_off" });
    s.web.themes.agent_edit = true;
    s.themes.setLocked("alpha", true);
    expect(propose(s, bundle())).toMatchObject({ error: "locked" });
    s.themes.setLocked("alpha", false);
    for (let i = 0; i < 3; i++) expect(propose(s, bundle({ name: `p${i}` }))).toHaveProperty("proposed");
    expect(propose(s, bundle({ name: "p3" }))).toMatchObject({ error: "rate_limited" });
    expect(s.mods.proposals().map(p => p.name), "one per agent: the newest").toEqual(["p2"]);
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

describe("wiring", () => {
  it("no target in either schema; worker and standard profiles only; IPC and endpoint ops", async () => {
    const schemas = await import("../src/outbound-schemas.js");
    const perms = await import("../src/tool-permissions.js");
    for (const s of [schemas.ExportWebModArgs, schemas.ProposeWebModArgs]) expect(Object.keys(s.shape).filter(k => /instance|target/.test(k))).toEqual([]);
    for (const tool of ["export_web_mod", "propose_web_mod"]) {
      expect([perms.TOOL_PROFILES.worker.includes(tool), perms.TOOL_PROFILES.standard.includes(tool), perms.TOOL_PROFILES.general.includes(tool)], tool).toEqual([true, true, false]);
      expect(Object.values(perms.IPC_TYPE_TOOLS)).toContain(tool);
      expect(Object.values(perms.EARLY_AGENT_OP_TOOLS)).toContain(tool);
    }
    const { TOOLS } = await import("../src/channel/mcp-tools.js");
    expect(TOOLS.map((t: { name: string }) => t.name).filter((n: string) => /import_web_mod|install_web_mod/.test(n)), "agents never import").toEqual([]);
  });
  it("the daemon: export fetched in parts and written to .agend/mods; propose read here and sent in parts; every IPC message < 1 MiB", async () => {
    const s = setup();
    dress(s, "a", noisy());
    const ws = tmp();
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
  it("agend-agent mod export / mod propose", async () => {
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
    const home = tmp(), ws = tmp();
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
