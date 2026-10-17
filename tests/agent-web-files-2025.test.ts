/** #2025: real private files, caller-scoped state exception, no live fleet/account/state. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { readAgentFile, writeAgentFile } from "../src/agent-file-read.js";
import { readAgentEffect, EffectUploads } from "../src/web-effect-upload.js";
import { writeModFile, writePreview } from "../src/web-asset-parts.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const parent = join(process.cwd(), ".artifacts"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "web-files-2025-")); roots.push(root);
  const stateDir = join(root, "state"), instance = "classic-測試-1234", workspace = join(stateDir, "workspaces", instance);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "asset.png"), "asset");
  const effect = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "effect.json"), JSON.stringify({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "test", title: "Test", regions: ["chat"], layer: "behind", wants: [] }));
    writeFileSync(join(dir, "worker.js"), "agend.ready()");
  };
  effect(join(workspace, "web-effects", "demo"));
  const opts = { workspace, stateDir, instance }, read = (file: string, extra = {}) => readAgentFile(file, { ...opts, maxBytes: 1024, ...extra });
  return { root, stateDir, workspace, instance, opts, read, effect };
}
describe("caller-owned state workspace", () => {
  it.each([false, true])("reads files and effects using absolute=%s, with no mandatory staging directory", async absolute => {
    const f = fixture(), file = absolute ? join(f.workspace, "asset.png") : "asset.png", dir = absolute ? join(f.workspace, "web-effects/demo") : "web-effects/demo";
    const r = await f.read(file); expect(r.ok).toBe(true); if (r.ok) expect(r.bytes.toString()).toBe("asset");
    const e = await readAgentEffect(dir, f.opts); expect(e.ok).toBe(true); if (e.ok) expect(Buffer.from(e.files.get("worker.js")!).toString()).toBe("agend.ready()");
  });
  it("uses canonical workspace and state roots when their ancestors are aliases", async () => {
    const f = fixture(), stateAlias = join(f.root, "state-alias"), cwdAlias = join(f.root, "cwd-alias");
    symlinkSync(f.stateDir, stateAlias, "dir"); symlinkSync(f.workspace, cwdAlias, "dir");
    expect(await f.read("asset.png", { stateDir: stateAlias, workspace: cwdAlias })).toMatchObject({ ok: true });
    expect(await readAgentEffect("web-effects/demo", { ...f.opts, stateDir: stateAlias, workspace: cwdAlias })).toMatchObject({ ok: true });
    writeFileSync(join(f.stateDir, ".env"), "private");
    expect((await f.read(join(f.stateDir, ".env"), { stateDir: stateAlias, workspace: f.stateDir })).ok).toBe(false);
  });
  it.each([undefined, "other", "..", "../other", "x/../../other", "/tmp", "a\\b", "a\0b"])("never infers ownership for caller %s", async instance => {
    const f = fixture(); expect((await f.read("asset.png", { instance })).ok).toBe(false);
    expect((await readAgentEffect("web-effects/demo", { ...f.opts, instance })).ok).toBe(false);
  });
  it.each(["x/..", "x/../..", "a\\b", "a\u0001b", ".", ".."])("invalid caller %j cannot widen the exception under a broad cwd", async instance => {
    const f = fixture(), opts = { ...f.opts, workspace: f.stateDir, instance };
    const other = join(f.stateDir, "workspaces/other"); mkdirSync(other, { recursive: true });
    writeFileSync(join(f.stateDir, ".env"), "private"); writeFileSync(join(other, "asset.png"), "other");
    // These paths exist, including POSIX names containing a backslash/control character. A missing
    // realpath must not mask the caller-character fence. Traversal names resolve to the parent roots.
    const normalized = resolve(f.stateDir, "workspaces", instance); mkdirSync(normalized, { recursive: true });
    writeFileSync(join(normalized, "attempt.png"), "private"); f.effect(join(normalized, "attempt-effect"));
    for (const file of [join(f.stateDir, ".env"), join(other, "asset.png"), join(normalized, "attempt.png")]) {
      expect(await readAgentFile(file, { ...opts, maxBytes: 1024 }), file).toMatchObject({ ok: false });
    }
    expect(await readAgentEffect(join(normalized, "attempt-effect"), opts)).toMatchObject({ ok: false });
  });
  it.each(["workspaces/other", "workspaces/classic-測試-1234-other", "instances/a", "credential-profiles/a", "inbox/a", ".env", "fleet.db"])("refuses protected state %s, even with a broad cwd", async part => {
    const f = fixture(), target = join(f.stateDir, part), file = part.includes(".") && !part.startsWith("workspaces/");
    if (file) writeFileSync(target, "private"); else { mkdirSync(target, { recursive: true }); writeFileSync(join(target, "secret"), "private"); f.effect(join(target, "effect")); }
    const p = file ? target : join(target, "secret");
    expect((await f.read(p)).ok).toBe(false);
    expect((await f.read(p, { workspace: f.stateDir })).ok).toBe(false);
    if (!file) expect((await readAgentEffect(join(target, "effect"), { ...f.opts, workspace: f.stateDir })).ok).toBe(false);
  });
  it("keeps cwd containment, including nested cwd and /tmp-like outside files", async () => {
    const f = fixture(), outside = join(f.root, "outside"); writeFileSync(outside, "outside");
    for (const p of [outside, relative(f.workspace, outside)]) expect((await f.read(p)).ok).toBe(false);
    const temp = mkdtempSync(join(tmpdir(), "agend-web-2025-")); roots.push(temp);
    const tempFile = join(temp, "asset.png"); writeFileSync(tempFile, "outside");
    expect((await f.read(tempFile)).ok).toBe(false);
    const nested = join(f.workspace, "sub"); mkdirSync(nested); writeFileSync(join(nested, "inside"), "x");
    expect(await f.read("inside", { workspace: nested })).toMatchObject({ ok: true });
    expect((await f.read("../asset.png", { workspace: nested })).ok).toBe(false);
    expect((await readAgentEffect(join(f.workspace, "web-effects/demo"), { ...f.opts, workspace: nested })).ok).toBe(false);
  });
  it("refuses file and directory symlinks into .env, other workspaces, and outside the cwd", async () => {
    const f = fixture(); writeFileSync(join(f.stateDir, ".env"), "secret"); writeFileSync(join(f.root, "outside"), "outside");
    symlinkSync(join(f.stateDir, ".env"), join(f.workspace, "leak.png")); expect((await f.read("leak.png")).ok).toBe(false);
    for (const [name, target] of [["state-link", f.stateDir], ["outside-link", f.root]] as const) {
      symlinkSync(target, join(f.workspace, name), "dir");
      expect((await f.read(join(name, name === "state-link" ? ".env" : "outside"))).ok).toBe(false);
      f.effect(join(target, "hostile-effect")); expect((await readAgentEffect(join(name, "hostile-effect"), f.opts)).ok).toBe(false);
    }
    symlinkSync(f.stateDir, join(f.workspace, "web-effects/demo/assets"), "dir");
    expect((await readAgentEffect("web-effects/demo", f.opts)).ok).toBe(false);
  });
  it.each(["workspaces/other", "instances/a", "credential-profiles/a"])("a planted caller workspace alias cannot authorize %s", async part => {
    const f = fixture(), target = join(f.stateDir, part); mkdirSync(target, { recursive: true }); writeFileSync(join(target, "asset.png"), "private"); f.effect(join(target, "effect"));
    rmSync(f.workspace, { recursive: true }); symlinkSync(target, f.workspace, "dir");
    expect((await f.read("asset.png")).ok).toBe(false);
    expect((await readAgentEffect("effect", f.opts)).ok).toBe(false);
    expect((await writeAgentFile("output", "a.svg", Buffer.from("x"), f.opts)).ok).toBe(false);
    expect(existsSync(join(target, "output"))).toBe(false);
  });
  it("normal project cwd still reads; state and outside remain refused", async () => {
    const f = fixture(), project = join(f.root, "project"); mkdirSync(project); writeFileSync(join(project, "image.png"), "project"); f.effect(join(project, "effect"));
    expect(await f.read("image.png", { workspace: project })).toMatchObject({ ok: true });
    expect(await readAgentEffect("effect", { ...f.opts, workspace: project })).toMatchObject({ ok: true });
    symlinkSync(f.stateDir, join(project, "state"), "dir"); writeFileSync(join(f.stateDir, ".env"), "secret");
    expect((await f.read("state/.env", { workspace: project })).ok).toBe(false);
    expect((await f.read(join(f.workspace, "asset.png"), { workspace: project })).ok).toBe(false);
  });
  it("generated previews and mod exports use the same exception and can be read back", async () => {
    const f = fixture(), mod = await writeModFile([{ name: "sample-1.0.0.agendmod.json", data: Buffer.from("mod") }], f.opts);
    expect(mod).toHaveProperty("path"); if ("path" in mod) expect(await f.read(mod.path)).toMatchObject({ ok: true });
    const preview = await writePreview([{ name: "dark.svg", data: Buffer.from("<svg/>") }], f.opts);
    expect(preview).toHaveProperty("files"); if ("files" in preview) expect(readFileSync(preview.files[0]!.path, "utf8")).toBe("<svg/>");
    expect((await writeAgentFile("credential-profiles", "no.json", Buffer.from("x"), { ...f.opts, workspace: f.stateDir })).ok).toBe(false);
    expect(existsSync(join(f.stateDir, "credential-profiles"))).toBe(false);
  });
});

describe("#2025 CLI effect upload", () => {
  it.each([false, true])("reads caller workspace bytes, absolute=%s", async absolute => {
    const f = fixture();
    const { createServer } = await import("node:http");
    const { execFile } = await import("node:child_process");
    const { pathToFileURL } = await import("node:url");
    const posts: Array<{ instance: string; op: string; args: Record<string, unknown> }> = [];
    const uploads = new EffectUploads(), id = "a".repeat(32);
    const server = createServer((req, res) => {
      let body = ""; req.on("data", c => { body += c; }); req.on("end", () => {
        const p = JSON.parse(body); posts.push(p);
        res.end(JSON.stringify(uploads.accept(f.instance, p.args, files => ({ id, files: [...files.keys()].sort() }))));
      });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const run = (dir: string, instance = f.instance) => new Promise<{ code: number; out: string }>(r => {
      execFile(process.execPath, ["--import", pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href,
        join(process.cwd(), "src/agent-cli.ts"), "effect", "upload", dir], {
        cwd: f.workspace, env: { ...process.env, AGEND_HOME: f.stateDir, AGEND_INSTANCE_NAME: instance, AGEND_PORT: String((server.address() as { port: number }).port) }, timeout: 30000,
      }, (err, stdout, stderr) => r({ code: err ? 1 : 0, out: stdout + stderr }));
    });
    try {
      const reply = await run(absolute ? join(f.workspace, "web-effects/demo") : "web-effects/demo");
      expect(reply.code).toBe(0); expect(JSON.parse(reply.out)).toEqual({ id, files: ["effect.json", "worker.js"] });
      expect(posts).toHaveLength(1); expect(posts[0]!.op).toBe("effect-upload");
      expect(Object.keys(posts[0]!.args).sort()).toEqual(["data_b64", "part"]);
      expect((await run("web-effects/demo", "other")).code).toBe(1);
      expect(posts).toHaveLength(1);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  }, 60000);
});
