/** Real private files/config only; no fleet, account or live state. */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAgentFile, writeAgentFile } from "../src/agent-file-read.js";
import { readAgentEffect } from "../src/web-effect-upload.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(part = "workspaces/alpha-home") {
  const parent = join(process.cwd(), ".artifacts"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "workspace-2131-")); roots.push(root);
  const stateDir = join(root, "state"), workspace = join(stateDir, part);
  const save = (file: string, bytes = "asset") => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, bytes); return file; };
  const config = (peers: Record<string, unknown> = {}) => save(join(stateDir, "fleet.yaml"), JSON.stringify({ instances: { alpha: { working_directory: workspace }, ...peers } }));
  config(); save(join(workspace, "portrait.webp")); save(join(workspace, "web-assets/banner.webp"));
  save(join(workspace, "effect/effect.json"), JSON.stringify({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "test", title: "Test", regions: ["chat"], layer: "behind", wants: [] }));
  save(join(workspace, "effect/worker.js"), "agend.ready()");
  const opts = { stateDir, workspace, instance: "alpha" }, read = (file: string, extra = {}) => readAgentFile(file, { ...opts, maxBytes: 4096, ...extra });
  return { root, stateDir, workspace, save, config, opts, read };
}
describe("#2131 exclusively configured workspace names", () => {
  it.each([false, true])("alpha can read its configured alpha-home files/effect without staging, absolute=%s", async absolute => {
    const f = fixture();
    for (const launch of [{}, { configuredWorkspace: f.workspace }]) {
      for (const file of ["portrait.webp", "web-assets/banner.webp"]) {
        expect(await f.read(absolute ? join(f.workspace, file) : file, launch)).toMatchObject({ ok: true, bytes: Buffer.from("asset") });
      }
      expect(await readAgentEffect(absolute ? join(f.workspace, "effect") : "effect", { ...f.opts, ...launch })).toMatchObject({ ok: true });
      const written = await writeAgentFile("ordinary-output", "sample.svg", Buffer.from("asset"), { ...f.opts, ...launch });
      expect(written).toMatchObject({ ok: true }); if (written.ok) expect(await f.read(written.path, launch)).toMatchObject({ ok: true });
    }
  });
  it("the configured root can come from effective fleet defaults", async () => {
    const f = fixture(); f.save(join(f.stateDir, "fleet.yaml"), JSON.stringify({ defaults: { working_directory: f.workspace }, instances: { alpha: {} } }));
    expect(await f.read("portrait.webp", { configuredWorkspace: f.workspace })).toMatchObject({ ok: true });
  });
  it("shell cwd and launch snapshot alone cannot claim an unconfigured name", async () => {
    const f = fixture(); f.save(join(f.stateDir, "fleet.yaml"), JSON.stringify({ instances: { alpha: {} } }));
    for (const launch of [{}, { configuredWorkspace: f.workspace }]) expect(await f.read("portrait.webp", launch)).toMatchObject({ ok: false });
  });
  it.each(["same", "parent", "child", "alias"])("configured %s peer overlap refuses existing files/effects and creates no output", async mode => {
    const f = fixture(); let other = mode === "parent" ? join(f.stateDir, "workspaces") : mode === "child" ? join(f.workspace, "web-assets") : f.workspace;
    if (mode === "alias") { other = join(f.root, "peer-alias"); symlinkSync(f.workspace, other, "dir"); }
    f.config({ peer: { working_directory: other } });
    expect(await f.read("portrait.webp")).toMatchObject({ ok: false }); expect(await readAgentEffect("effect", f.opts)).toMatchObject({ ok: false });
    expect(await writeAgentFile("new-output", "sample.svg", Buffer.from("x"), f.opts)).toMatchObject({ ok: false }); expect(existsSync(join(f.workspace, "new-output"))).toBe(false);
  });
  it.each(["workspaces/peer", "workspaces/peer/project", "workspaces"])("another instance's standard folder or workspace root %s is never borrowed", async part => {
    const f = fixture(part), elsewhere = join(f.root, "project"); mkdirSync(elsewhere);
    // The peer is configured elsewhere; its standard directory must still stay protected.
    f.config({ peer: { working_directory: elsewhere } });
    expect(await f.read("portrait.webp")).toMatchObject({ ok: false }); expect(await readAgentEffect("effect", f.opts)).toMatchObject({ ok: false });
    expect(await writeAgentFile("new-output", "sample.svg", Buffer.from("x"), f.opts)).toMatchObject({ ok: false });
  });
  it("symlinked configured workspace cannot claim an otherwise admissible folder", async () => {
    const f = fixture(), target = join(f.stateDir, "workspaces/target"); f.save(join(target, "portrait.webp"));
    rmSync(f.workspace, { recursive: true }); symlinkSync(target, f.workspace, "dir");
    expect(await f.read("portrait.webp")).toMatchObject({ ok: false }); expect(await writeAgentFile("new-output", "x.svg", Buffer.from("x"), f.opts)).toMatchObject({ ok: false });
    expect(existsSync(join(target, "new-output"))).toBe(false);
  });
  it("hardlinks and symlinks remain refused inside an admitted configured workspace", async () => {
    const f = fixture(), secret = f.save(join(f.stateDir, ".env"), "secret");
    linkSync(secret, join(f.workspace, "hard.webp")); symlinkSync(secret, join(f.workspace, "linked.webp"));
    for (const file of ["hard.webp", "linked.webp"]) expect(await f.read(file)).toMatchObject({ ok: false });
  });
  it.each([".env", "fleet.db", "state.sqlite3-wal", "instances/a/file", "credential-profiles/a/file", "inbox/image.png", "sessions/a.json", ".claude/settings.json"])("configured workspace still refuses sensitive %s", async part => {
    const f = fixture(); f.save(join(f.workspace, part)); expect(await f.read(part)).toMatchObject({ ok: false });
  });
  it("General-style roots keep staging-only access and the state root remains refused", async () => {
    for (const part of ["general", ""]) {
      const f = fixture(part); expect(await f.read("portrait.webp")).toMatchObject({ ok: false });
      expect(await f.read("web-assets/banner.webp")).toMatchObject({ ok: part === "general" });
      expect(await readAgentEffect("effect", f.opts)).toMatchObject({ ok: false });
    }
  });
});
