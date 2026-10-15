/**
 * #1629 r4 §1, §7.2: an agent's read-only view of how it appears — get_web_appearance and preview_web_appearance.
 * - No target in either schema: always the caller's own.
 * - get_web_appearance resolves the face as the status frame and the page do, over all five sources (profile, theme,
 *   bot, emoji, initial), with the ring, the card field by field, the theme per mode, the lock and the limits.
 * - The SVG embeds only this instance's pictures as data: URIs and references nothing else (no http, no //, no other
 *   instance); its text is escaped; another instance's theme never appears.
 * - The fleet never names or opens a path: the files are bytes, written by the daemon or the CLI into the agent's own
 *   .agend/appearance/ (no symlinked folder, never the AgEnD state directory); a large preview comes in parts.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schemas from "../src/outbound-schemas.js";
import { resolvedAvatar, resolvedRing, previewSvg, type FrameEntry } from "../src/web-appearance-view.js";
import { AppearanceTools, PREVIEW_IDLE_MS } from "../src/web-appearance-tools.js";
import { receivePreview } from "../src/web-asset-parts.js";
import { writeAgentFile } from "../src/agent-file-read.js";
import { page, type AppPage } from "./helpers/app-harness.js";

const dirs: string[] = [];
let pg: AppPage | null = null;
afterEach(() => { vi.restoreAllMocks(); if (pg) { pg.restore(); pg = null; } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w = 4, h = 4, extra = 0, seed = 7) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...be32(13), ...Buffer.from("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0]),
  Buffer.from([...be32(1 + extra), ...Buffer.from("IDAT")]), Buffer.alloc(1 + extra, seed), Buffer.from([0, 0, 0, 0, ...be32(0), ...Buffer.from("IEND"), 0, 0, 0, 0])]);

describe("no target", () => {
  it("neither schema names an instance", () => {
    for (const s of [schemas.GetWebAppearanceArgs, schemas.PreviewWebAppearanceArgs]) {
      expect(Object.keys(s.shape).filter(k => /instance|name|target|to$/i.test(k))).toEqual([]);
    }
    expect(Object.keys(schemas.PreviewWebAppearanceArgs.shape)).toEqual(["modes"]);
  });
});

describe("the face and ring, as the page resolves them (all five sources)", () => {
  const ID = "a".repeat(32);
  const ROWS: Array<[string, FrameEntry, string, string | null]> = [
    ["theme", { name: "w", avatar: { kind: "image", src: "/ui/img/bot/conn-1?v=1" }, accent: "#ff0000", theme_avatar: { kind: "image", src: `/ui/img/theme/w/${ID}` }, theme_accent: "#8b5cf6" }, `/ui/img/theme/w/${ID}`, "#8b5cf6"],
    ["profile", { name: "w", avatar: { kind: "image", src: "/ui/img/avatar/w?v=k1" } }, "/ui/img/avatar/w?v=k1", null],
    ["bot", { name: "w", avatar: { kind: "image", src: "/ui/img/bot/conn-1?v=1" }, accent: "#ff0000" }, "/ui/img/bot/conn-1?v=1", "#ff0000"],
    ["emoji", { name: "w", avatar: { kind: "emoji", text: "🦊" } }, "", null],
    ["initial", { name: "worker", display_name: "Worker", avatar: { kind: "initial", text: "W" } }, "", null],
  ];
  it.each(ROWS)("%s", async (source, entry, src, ring) => {
    vi.resetModules();
    pg = page({ url: "http://127.0.0.1:19280/ui/fleet" });
    const nav = await import("/assets/instance-nav.js");
    const page_ = nav.avatarOf(entry);                                       // what the sidebar draws (themes shown)
    const got = resolvedAvatar(entry);
    expect(got.source).toBe(source);
    expect([got.url ?? "", page_.kind === "image" ? page_.src : ""]).toEqual([src, src]);
    expect(resolvedRing(entry)?.color ?? null).toBe(ring);
  });
});

/** A small fleet's resolvers: two instances, each with its own theme and pictures. */
function tools(opts: { big?: boolean; clock?: () => number } = {}) {
  const pics: Record<string, Buffer> = {
    "a:avatar": png(8, 8, 1, 1), "a:bg": png(8, 8, 2, 2), "a:portrait": png(30, 40, opts.big ? 900_000 : 3, 3), "a:banner": png(60, 20, 4, 4),
    "b:avatar": png(8, 8, 5, 5), "b:bg": png(8, 8, 6, 6),
  };
  const id = (k: string) => (k.charCodeAt(0) === 97 ? "a" : "b").repeat(31) + String(Object.keys(pics).indexOf(k));
  const ids = Object.fromEntries(Object.keys(pics).map(k => [k, id(k)]));
  const themes: Record<string, any> = {
    a: { v: 1, accent: "#8b5cf6", avatar: ids["a:avatar"], background: { image: ids["a:bg"], fit: "cover", opacity: 0.4 }, workingLabel: "Brewing <now>", card: { portrait: ids["a:portrait"], banner: ids["a:banner"] } },
    b: { v: 1, accent: "#00ff00", avatar: ids["b:avatar"], background: { image: ids["b:bg"], fit: "cover", opacity: 0.4 }, workingLabel: "B's label" },
  };
  const asset = (name: string, aid: string) => { const k = Object.keys(ids).find(x => ids[x] === aid && x.startsWith(name + ":")); return k ? { bytes: pics[k]!, mime: "image/png" } : null; };
  const t = new AppearanceTools({
    frame: (name) => ({ name, display_name: name === "a" ? "Agent <A>" : "Agent B", avatar: { kind: "initial", text: name.toUpperCase() }, theme_avatar: { kind: "image", src: `/ui/img/theme/${name}/${themes[name].avatar}` }, theme_accent: themes[name].accent }),
    theme: (name) => ({ theme: themes[name], locked: false }),
    card: (name) => (name === "a" ? { portrait: { id: ids["a:portrait"]!, by: "agent", src: "/api/card/a/portrait" }, banner: { id: ids["a:banner"]!, by: "human", src: "/api/card/a/banner" }, tagline: { text: "Reviews <b>PRs</b>", by: "human" }, bio: { text: "one\ntwo", by: "agent" } } : {}),
    cardPicture: (name, slot) => (name === "a" ? { bytes: pics[`a:${slot}`]!, mime: "image/png" } : null),
    themeAsset: asset,
    profileAvatar: () => null,
    botAvatar: () => null,
    themeAnswer: () => ({ agent_edit: true, limits: { changes: 10 } }),
    clock: opts.clock,
  });
  return { t, pics, ids };
}

describe("get_web_appearance", () => {
  it("the caller's look: face, ring, card field by field, theme per mode, lock and limits — nothing of another instance", () => {
    const { t, ids } = tools();
    const a = t.handle("a", "get_web_appearance", { name: "b" }) as Record<string, any>;   // a stray target is ignored
    expect([a.name, a.avatar, a.ring, a.card.tagline, a.card.portrait.by, a.working_label, a.locked, a.agent_edit, a.limits, a.effects, a.widgets])
      .toEqual(["a", { source: "theme", url: `/ui/img/theme/a/${ids["a:avatar"]}` }, { color: "#8b5cf6", source: "theme" }, { text: "Reviews <b>PRs</b>", by: "human" }, "agent", "Brewing <now>", false, true, { changes: 10 }, [], []]);
    expect([a.theme.dark.accent, a.theme.light.bg, a.theme.dark.bg]).toEqual(["#8b5cf6", "#ffffff", "#212121"]);
    expect(JSON.stringify(a)).not.toMatch(/Agent B|B's label|#00ff00/);
  });
});

describe("through the fleet (its own resolvers)", () => {
  it("the frame's face and ring, the person's card over the agent's, this instance only; a preview of its own pictures", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const dir = tmp("agend-app-fm-");
    const fm = new FleetManager(dir) as any;
    const quiet = () => {};
    fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
    fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp" }, beta: { working_directory: "/tmp" } }, defaults: {} };
    vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");
    const av = fm.themeStore.addAsset("alpha", "avatar", png(8, 8, 1, 1)).id, bav = fm.themeStore.addAsset("beta", "avatar", png(8, 8, 2, 2)).id;
    fm.webAppearance.setTheme("alpha", { set: { accent: "#8b5cf6", avatar: av, card: { tagline: "Agent's" } } });
    fm.themeStore.setTheme("beta", { v: 1, accent: "#00ff00", avatar: bav }, "agent");
    const { HumanCardStore } = await import("../src/web-card.js");
    const Database = (await import("better-sqlite3")).default;
    let db: any = null;
    new HumanCardStore(dir, () => (db ??= new Database(join(dir, "profiles.db")))).setText("alpha", { tagline: "A person's" });
    const a = await fm.handleWebThemeHttp("alpha", "get_web_appearance", {});
    expect([a.avatar, a.ring, a.card.tagline]).toEqual([{ source: "theme", url: `/ui/img/theme/alpha/${av}` }, { color: "#8b5cf6", source: "theme" }, { text: "A person's", by: "human" }]);
    const frame = fm.getUiStatus().instances.find((i: any) => i.name === "alpha");
    expect(a.avatar.url).toBe(frame.theme_avatar.src);
    const p = await fm.handleWebThemeHttp("alpha", "preview_web_appearance", { modes: ["dark"] });
    const svg = Buffer.from(p.files[0].data_b64, "base64").toString("utf8");
    expect([svg.includes(png(8, 8, 1, 1).toString("base64")), svg.includes(png(8, 8, 2, 2).toString("base64")), /#00ff00|beta/.test(svg)]).toEqual([true, false, false]);
    db?.close();
  }, 60_000);
});

describe("preview_web_appearance's SVG", () => {
  it("only this instance's pictures, inline; no http, no //, no other instance; text escaped", () => {
    const { t, pics } = tools();
    const r = t.handle("a", "preview_web_appearance", {}) as { files: Array<{ mode: string; data_b64: string }> };
    expect(r.files.map(f => f.mode)).toEqual(["light", "dark"]);
    for (const f of r.files) {
      const svg = Buffer.from(f.data_b64, "base64").toString("utf8");
      const refs = [...svg.matchAll(/href="([^"]*)"/g)].map(m => m[1]!);
      expect(refs.length).toBe(4);                                          // avatar, portrait, banner, background
      expect(refs.every(h => h.startsWith("data:image/png;base64,"))).toBe(true);
      expect(refs.map(h => Buffer.from(h.slice("data:image/png;base64,".length), "base64")).every(b => ["a:avatar", "a:bg", "a:portrait", "a:banner"].some(k => pics[k]!.equals(b)))).toBe(true);
      expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(/http|\/\/|Agent B|B's label|#00ff00/);
      expect(svg).toContain("Reviews &lt;b&gt;PRs&lt;/b&gt;");
      expect(svg).toContain("Agent &lt;A&gt;");
      expect(svg).not.toMatch(/<b>|<script|on[a-z]+=/i);
    }
    expect(previewSvg).toBeTypeOf("function");
  });
  it("modes: light and/or dark only", () => {
    const { t } = tools();
    expect((t.handle("a", "preview_web_appearance", { modes: ["dark"] }) as any).files.map((f: any) => f.mode)).toEqual(["dark"]);
    for (const modes of [[], ["sepia"], ["dark", "dark"], "dark", ["light", "dark", "light"]]) expect(t.handle("a", "preview_web_appearance", { modes }), JSON.stringify(modes)).toMatchObject({ error: "modes" });
  });
  it("a large preview comes in parts, its own, while fresh — reassembled to the same bytes", async () => {
    let now = 0;
    const { t } = tools({ big: true, clock: () => now });
    const first = t.handle("a", "preview_web_appearance", { modes: ["light"] }) as Record<string, any>;
    expect([typeof first.preview, first.files[0].parts > 1, Object.hasOwn(first.files[0], "data_b64")]).toEqual(["string", true, false]);
    const got = await receivePreview(first, async (a) => t.handle("a", "preview_web_appearance", a));
    expect("files" in got && got.files[0]!.data.toString("utf8").startsWith("<?xml")).toBe(true);
    expect(t.handle("b", "preview_web_appearance", { part: { preview: first.preview, mode: "light", index: 0 } })).toMatchObject({ error: "preview" });   // not b's
    expect(t.handle("a", "preview_web_appearance", { part: { preview: first.preview, mode: "light", index: 99 } })).toMatchObject({ error: "part" });
    now = PREVIEW_IDLE_MS + 1;
    expect(t.handle("a", "preview_web_appearance", { part: { preview: first.preview, mode: "light", index: 0 } })).toMatchObject({ error: "preview" });
    const tampered = await receivePreview({ ...first, files: [{ ...first.files[0], sha256: "0".repeat(64) }] }, async () => ({ data_b64: "AAAA" }));
    expect(tampered).toMatchObject({ error: "preview" });
  });
  it("the fleet's side opens no file and names no path (its modules import no fs)", () => {
    for (const f of ["src/web-appearance-view.ts", "src/web-appearance-tools.ts"]) expect(readFileSync(join(process.cwd(), f), "utf8")).not.toMatch(/from "node:fs|from "fs|readFile|writeFile/);
  });
});

describe("written on the agent's side", () => {
  it("into .agend/appearance in the working directory; a planted symlink at the name is replaced, never followed", async () => {
    const ws = tmp("agend-app-ws-"), state = tmp("agend-app-state-"), outside = join(tmp("agend-app-out-"), "victim.txt");
    writeFileSync(outside, "keep");
    mkdirSync(join(ws, ".agend", "appearance"), { recursive: true });
    symlinkSync(outside, join(ws, ".agend", "appearance", "dark.svg"));
    const w = await writeAgentFile(".agend/appearance", "dark.svg", Buffer.from("<svg/>"), { workspace: ws, stateDir: state });
    expect(w).toEqual({ ok: true, path: join(ws, ".agend", "appearance", "dark.svg") });
    expect([readFileSync(outside, "utf8"), lstatSync(join(ws, ".agend", "appearance", "dark.svg")).isSymbolicLink(), readFileSync(join(ws, ".agend", "appearance", "dark.svg"), "utf8")]).toEqual(["keep", false, "<svg/>"]);
  });
  it("refused: a symlinked folder, the AgEnD state directory (a working directory that is $HOME), a name that is a path", async () => {
    const ws = tmp("agend-app-ws-"), elsewhere = tmp("agend-app-else-");
    symlinkSync(elsewhere, join(ws, ".agend"));
    expect(await writeAgentFile(".agend/appearance", "light.svg", Buffer.from("x"), { workspace: ws, stateDir: tmp("s-") })).toEqual({ ok: false, reason: ".agend is not a plain folder" });
    expect(readlinkSync(join(ws, ".agend"))).toBe(elsewhere);
    const home = tmp("agend-app-home-");
    expect(await writeAgentFile(".agend/appearance", "light.svg", Buffer.from("x"), { workspace: home, stateDir: join(home, ".agend") })).toEqual({ ok: false, reason: "inside the AgEnD state directory" });
    for (const name of ["../x.svg", ".hidden", "a/b.svg"]) expect(await writeAgentFile(".agend/appearance", name, Buffer.from("x"), { workspace: tmp("w-"), stateDir: tmp("s-") }), name).toEqual({ ok: false, reason: "not a plain name" });
  });
  it("the daemon: asks the fleet, takes the parts, writes each mode, answers with the paths", async () => {
    const ws = tmp("agend-app-ws-");
    const { t } = tools({ big: true });
    const { Daemon } = await import("../src/daemon.js");
    const daemon = new Daemon("a", { working_directory: ws, log_level: "error", restart_policy: { max_retries: 1, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 } } as never, join(ws, ".instance"), true, undefined, undefined, pino({ level: "silent" }) as never) as any;
    const send = vi.fn((_socket: unknown, _msg: unknown) => true);
    const sizes: number[] = [];
    daemon.ipcServer = { send, broadcast: (msg: any) => {
      sizes.push(JSON.stringify(msg).length);
      expect(msg.type).toBe("fleet_preview_web_appearance");
      const result = t.handle(msg.meta.instance_name, "preview_web_appearance", msg.payload);
      setImmediate(() => { const r = JSON.stringify({ result }); sizes.push(r.length); daemon.pendingIpcRequests.get(msg.fleetRequestId)?.({ result }); });
    } };
    daemon.handleToolCall({ tool: "preview_web_appearance", args: {}, requestId: 9 }, {} as never);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), { timeout: 10_000 });
    const answer = send.mock.calls[0]![1] as { requestId: number; result: { files: Array<{ mode: string; path: string }> } };
    expect(answer.result.files.map(f => [f.mode, f.path])).toEqual([["light", join(ws, ".agend", "appearance", "light.svg")], ["dark", join(ws, ".agend", "appearance", "dark.svg")]]);
    expect(readFileSync(answer.result.files[1]!.path, "utf8")).toMatch(/^<\?xml/);
    expect(Math.max(...sizes)).toBeLessThan(1024 * 1024);
  });
  it("agend-agent appearance / appearance preview dark: one op each; the preview is written in the working directory", async () => {
    const { createServer } = await import("node:http");
    const { execFile } = await import("node:child_process");
    const { t } = tools();
    const ops: string[] = [];
    const server = createServer((req, res) => { let body = ""; req.on("data", c => { body += c; }); req.on("end", () => {
      const p = JSON.parse(body); ops.push(p.op);
      res.end(JSON.stringify(t.handle("a", p.op === "appearance-get" ? "get_web_appearance" : "preview_web_appearance", p.args)));
    }); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const home = tmp("agend-app-cli-"), ws = tmp("agend-app-cli-ws-");
    const run = (...argv: string[]) => new Promise<string>(resolve => execFile(process.execPath, ["--import", pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href, join(process.cwd(), "src/agent-cli.ts"), ...argv], {
      cwd: ws, env: { ...process.env, AGEND_PORT: String(port), AGEND_INSTANCE_NAME: "a", AGEND_HOME: home }, timeout: 60_000 }, (_e, stdout) => resolve(stdout)));
    try {
      expect(JSON.parse(await run("appearance")).name).toBe("a");
      expect(JSON.parse(await run("appearance", "preview", "dark"))).toEqual({ files: [{ mode: "dark", path: join(ws, ".agend", "appearance", "dark.svg") }] });
      expect(readFileSync(join(ws, ".agend", "appearance", "dark.svg"), "utf8")).toMatch(/^<\?xml/);
      expect(ops).toEqual(["appearance-get", "appearance-preview"]);
    } finally { await new Promise(r => server.close(r)); }
  }, 120_000);
});
