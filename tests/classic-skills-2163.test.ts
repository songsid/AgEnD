/**
 * #2163: a ClassicBot room's agent was told by what's-new to "load the `web-appearance` skill", which AgEnD never gave
 * it; and an entry for General reached every instance.
 * - A Classic workspace AgEnD manages (<AGEND_HOME>/workspaces/<name>) gets the skills marked `classic` (web-appearance,
 *   persona-emoji, web-dashboard) and nothing about running the fleet; one elsewhere gets nothing; a user's own skill of
 *   the same name is never touched.
 * - `agend-agent skill [name]` reads any bundled skill, anywhere, with no fleet.
 * - What's-new entries have an audience: an entry for General/coordinators is recorded, not told, elsewhere; a notice
 *   that names a skill says how to read it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { FleetManager, insideManagedWorkspaces } from "../src/fleet-manager.js";
import { DEFAULT_INSTANCE_CONFIG } from "../src/config.js";
import type { InstanceConfig } from "../src/types.js";
import { AGENT_WHATS_NEW, planWhatsNew, readWhatsNewRecord, SKILL_READ_HINT, whatsNewNotice } from "../src/agent-whats-new.js";
import { listBundledSkills, readBundledSkill } from "../src/bundled-skills.js";
import { Daemon } from "../src/daemon.js";

const roots: string[] = [];
const scratch = (p = "agend-2163-") => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };
let savedHome: string | undefined;
beforeEach(() => { savedHome = process.env.AGEND_HOME; });
afterEach(() => {
  if (savedHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = savedHome;
  vi.restoreAllMocks();
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CLASSIC = ["persona-emoji", "web-appearance", "web-dashboard"];

async function startClassic(workDir: string, backend = "codex") {
  const fm = new FleetManager(scratch("agend-2163-data-")) as any;
  const config: InstanceConfig = { ...DEFAULT_INSTANCE_CONFIG, working_directory: workDir, backend, lightweight: true };
  fm.fleetConfig = { defaults: {}, instances: {} };
  vi.spyOn(fm.lifecycle, "start").mockResolvedValue(undefined);
  vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
  await fm.startInstance("room-bot", config, false, "classic");
  return fm;
}
const published = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(n => !n.startsWith(".")).sort() : [];

describe("#2163: skills for a ClassicBot room's agent", () => {
  it("an AgEnD-managed workspace gets exactly the classic skills — nothing about running the fleet", async () => {
    const home = scratch(); process.env.AGEND_HOME = home;
    const work = join(home, "workspaces", "room-bot");
    await startClassic(work);
    expect(published(join(work, ".agents", "skills"))).toEqual(CLASSIC);
    expect(JSON.parse(readFileSync(join(work, ".agents", "skills", ".agend-managed-skills.json"), "utf8")).sort()).toEqual(CLASSIC);
    expect(readFileSync(join(work, ".agents", "skills", "web-appearance", "SKILL.md"), "utf8")).toBe(readBundledSkill("web-appearance").ok && (readBundledSkill("web-appearance") as { text: string }).text);
  });
  it("claude-code's folder too (each backend's own skill folder)", async () => {
    const home = scratch(); process.env.AGEND_HOME = home;
    const work = join(home, "workspaces", "room-bot");
    await startClassic(work, "claude-code");
    expect(published(join(work, ".claude", "skills"))).toEqual(CLASSIC);
  });
  it("a user's own skill of the same name in a managed workspace is never touched; their other files neither", async () => {
    const home = scratch(); process.env.AGEND_HOME = home;
    const work = join(home, "workspaces", "room-bot");
    mkdirSync(join(work, ".agents", "skills", "web-appearance"), { recursive: true });
    writeFileSync(join(work, ".agents", "skills", "web-appearance", "SKILL.md"), "mine\n");
    writeFileSync(join(work, "notes.md"), "my notes\n");
    await startClassic(work);
    expect(readFileSync(join(work, ".agents", "skills", "web-appearance", "SKILL.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("my notes\n");
    expect(published(join(work, ".agents", "skills"))).toEqual(CLASSIC);   // the other two published beside it
  });
  it("a workspace outside <AGEND_HOME>/workspaces/ — or a link pointing out of it — gets nothing written", async () => {
    const home = scratch(); process.env.AGEND_HOME = home;
    const outside = scratch("agend-2163-user-");
    await startClassic(outside);
    expect(existsSync(join(outside, ".agents"))).toBe(false);
    mkdirSync(join(home, "workspaces"), { recursive: true });
    symlinkSync(outside, join(home, "workspaces", "linked"));
    expect(insideManagedWorkspaces(join(home, "workspaces", "linked"), home)).toBe(false);
    expect(insideManagedWorkspaces(join(home, "workspaces"), home)).toBe(false);          // the root itself
    expect(insideManagedWorkspaces(join(home, "workspaces", "a", "b"), home)).toBe(true);  // not created yet: by path
    expect(insideManagedWorkspaces(join(home, "workspaces-x", "a"), home)).toBe(false);
    expect(insideManagedWorkspaces(join(home, "workspaces", "linked", "new-child"), home)).toBe(false);  // missing, under a link out
    symlinkSync(join(outside, "gone"), join(home, "workspaces", "broken"));
    expect(insideManagedWorkspaces(join(home, "workspaces", "broken"), home)).toBe(false);              // a broken link
    expect(insideManagedWorkspaces(join(home, "workspaces", "broken", "x"), home)).toBe(false);
  });
  it("a missing working folder under a link out of workspaces/: nothing is created out there", async () => {
    const home = scratch(); process.env.AGEND_HOME = home;
    const outside = scratch("agend-2163-user-");
    mkdirSync(join(home, "workspaces"), { recursive: true });
    symlinkSync(outside, join(home, "workspaces", "linked"));
    await startClassic(join(home, "workspaces", "linked", "new-child"));
    expect(readdirSync(outside)).toEqual([]);
  });
  it("a managed workspace whose skills folder is a link out: nothing written there — no skill, no manifest", async () => {
    for (const [backend, segs] of [["codex", [".agents", "skills"]], ["claude-code", [".claude", "skills"]]] as const) {
      const home = scratch(); process.env.AGEND_HOME = home;
      const outside = scratch("agend-2163-user-");
      writeFileSync(join(outside, "theirs.md"), "x\n");
      const work = join(home, "workspaces", "room-bot");
      mkdirSync(join(work, segs[0]), { recursive: true });
      symlinkSync(outside, join(work, ...segs));
      await startClassic(work, backend);
      expect(readdirSync(outside), backend).toEqual(["theirs.md"]);
      // the folder holding it (.agents / .claude) linked out instead: the same
      const home2 = scratch(); process.env.AGEND_HOME = home2;
      const outside2 = scratch("agend-2163-user-");
      const work2 = join(home2, "workspaces", "room-bot");
      mkdirSync(work2, { recursive: true });
      symlinkSync(outside2, join(work2, segs[0]));
      await startClassic(work2, backend);
      expect(readdirSync(outside2), backend).toEqual([]);
    }
  });
  it("a managed skill folder replaced by a link out later: that skill is skipped, the rest still published", async () => {
    const home = scratch(); process.env.AGEND_HOME = home;
    const work = join(home, "workspaces", "room-bot");
    await startClassic(work);
    const outside = scratch("agend-2163-user-");
    rmSync(join(work, ".agents", "skills", "web-appearance"), { recursive: true });
    symlinkSync(outside, join(work, ".agents", "skills", "web-appearance"));
    await startClassic(work);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(work, ".agents", "skills", "web-dashboard", "SKILL.md"))).toBe(true);
  });
  it("a manifest replaced by a link to a file elsewhere: that file is not overwritten", async () => {
    const home = scratch(); process.env.AGEND_HOME = home;
    const work = join(home, "workspaces", "room-bot");
    await startClassic(work);
    const outside = scratch("agend-2163-user-");
    writeFileSync(join(outside, "theirs.json"), "keep\n");
    const manifest = join(work, ".agents", "skills", ".agend-managed-skills.json");
    rmSync(manifest);
    symlinkSync(join(outside, "theirs.json"), manifest);
    await startClassic(work);
    expect(readFileSync(join(outside, "theirs.json"), "utf8")).toBe("keep\n");
  });
  it("a manifest linked to a valid one elsewhere is not believed: the user's own skill it names stays, that file too", async () => {
    const home = scratch(); process.env.AGEND_HOME = home;
    const work = join(home, "workspaces", "room-bot");
    const skills = join(work, ".agents", "skills");
    mkdirSync(join(skills, "fleet-health"), { recursive: true });
    writeFileSync(join(skills, "fleet-health", "SKILL.md"), "my own fleet-health\n");
    const outside = scratch("agend-2163-user-");
    writeFileSync(join(outside, "manifest.json"), JSON.stringify(["fleet-health"]) + "\n");
    symlinkSync(join(outside, "manifest.json"), join(skills, ".agend-managed-skills.json"));
    await startClassic(work);
    expect(readFileSync(join(skills, "fleet-health", "SKILL.md"), "utf8")).toBe("my own fleet-health\n");
    expect(readFileSync(join(outside, "manifest.json"), "utf8")).toBe(JSON.stringify(["fleet-health"]) + "\n");
  });
  it("a real local manifest still retires a skill no longer Classic's", async () => {
    const home = scratch(); process.env.AGEND_HOME = home;
    const work = join(home, "workspaces", "room-bot");
    const skills = join(work, ".agents", "skills");
    await startClassic(work);
    mkdirSync(join(skills, "fleet-health"), { recursive: true });
    writeFileSync(join(skills, "fleet-health", "SKILL.md"), "published once\n");
    writeFileSync(join(skills, ".agend-managed-skills.json"), JSON.stringify([...CLASSIC, "fleet-health"]) + "\n");
    await startClassic(work);
    expect(published(skills)).toEqual(CLASSIC);
  });
  it("the bundled frontmatter marks exactly those three for classic", () => {
    const classic = listBundledSkills().map(s => s.name).filter(n => /roles:\s*\[[^\]]*\bclassic\b/.test(readFileSync(join(__dirname, "..", "src", "general-knowledge", "skills", n, "SKILL.md"), "utf8")));
    expect(classic).toEqual(CLASSIC);
  });
});

describe("#2163: agend-agent skill", () => {
  it("lists every bundled skill with its description, and reads one whole; refuses anything else", () => {
    const list = listBundledSkills();
    expect(list.map(s => s.name)).toContain("web-appearance");
    expect(list.find(s => s.name === "web-appearance")!.description).toMatch(/web dashboard/);
    const r = readBundledSkill("web-appearance");
    expect(r.ok && r.text.startsWith("---\nname: web-appearance")).toBe(true);
    // Including a path that WOULD reach a real SKILL.md by traversal: only a bundled skill's own name is read.
    for (const bad of ["../../etc/passwd", "web-appearance/../x", "../skills/web-appearance", "./web-appearance", "", "WEB-APPEARANCE", "no-such-skill"]) expect(readBundledSkill(bad).ok, bad).toBe(false);
  });
  it("the command works with no instance and no fleet (a Classic agent's shell)", async () => {
    const run = (...argv: string[]) => new Promise<{ code: number; out: string }>(resolve => execFile(process.execPath,
      ["--import", pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href, join(process.cwd(), "src/agent-cli.ts"), ...argv],
      { env: { PATH: process.env.PATH, HOME: scratch() }, timeout: 60_000 }, (e, stdout, stderr) => resolve({ code: e ? (e as { code?: number }).code ?? 1 : 0, out: stdout + stderr })));
    const one = await run("skill", "web-appearance");
    expect([one.code, one.out.startsWith("---\nname: web-appearance")]).toEqual([0, true]);
    const all = await run("skill");
    expect(all.code).toBe(0);
    expect(all.out.split("\n").filter(Boolean).map(l => l.split("\t")[0])).toEqual(listBundledSkills().map(s => s.name));
    const bad = await run("skill", "../x");
    expect(bad.code).not.toBe(0);
  }, 120_000);
});

describe("#2163: what's-new by role", () => {
  const V = "2.3.0";
  const record = { announced: AGENT_WHATS_NEW.filter(e => !e.id.startsWith("2.3-")).map(e => e.id) };
  const shownIds = (roles: Parameters<typeof planWhatsNew>[0]["roles"]) => {
    const p = planWhatsNew({ record, fresh: false, version: V, roles });
    return p && "notice" in p ? { ids: p.ids, notice: p.notice } : null;
  };
  it("the General/coordinator entry is told to General and coordinators only — recorded for everyone", () => {
    const settings = "2.3-web-settings-for-the-user";
    for (const [roles, told] of [[["general"], true], [["worker", "coordinator"], true], [["worker"], false], [["classic"], false]] as const) {
      const r = shownIds(roles)!;
      expect(r.ids, String(roles)).toContain(settings);                                   // recorded either way
      expect(r.notice.includes("get_web_settings"), String(roles)).toBe(told);
    }
    expect(shownIds(undefined)!.notice).toContain("get_web_settings");                     // no roles: as before
  });
  it("nothing left for this role: recorded silently, nothing pending", () => {
    const only = AGENT_WHATS_NEW.filter(e => e.id === "2.3-web-settings-for-the-user");
    expect(planWhatsNew({ record: { announced: [] }, fresh: false, version: V, entries: only, roles: ["classic"] }))
      .toEqual({ silent: ["2.3-web-settings-for-the-user"], version: V });
  });
  it("a notice naming a skill says how to read it anywhere; one naming none does not", () => {
    expect(whatsNewNotice(V, AGENT_WHATS_NEW.filter(e => e.id === "2.3-web-ambient"))).toContain(SKILL_READ_HINT);
    expect(whatsNewNotice(V, AGENT_WHATS_NEW.filter(e => e.id === "2.3-repo-tools"))).not.toContain(SKILL_READ_HINT);
    expect(SKILL_READ_HINT).toContain("agend-agent skill <name>");
  });
  it("every entry that names a bundled skill — with or without backticks — carries the hint on its own", () => {
    const names = listBundledSkills().map(s => s.name);
    // An unquoted one-word name ("scheduling skill") is not told apart from "the skill"; entries quote those.
    const naming = AGENT_WHATS_NEW.filter(e => names.some(n => (n.includes("-") && e.text.includes(`${n} skill`)) || e.text.includes(`\`${n}\` skill`)));
    for (const n of names.filter(n => !n.includes("-"))) {
      expect(AGENT_WHATS_NEW.filter(e => new RegExp(`(?<!\`)\\b${n} skill`).test(e.text)).map(e => e.id), n).toEqual([]);
    }
    expect(whatsNewNotice(V, [{ id: "t", since: "0", text: "Load the `scheduling` skill." }])).toContain(SKILL_READ_HINT);
    expect(naming.map(e => e.id)).toContain("2.3-web-verified");          // "the cross-instance-messaging skill", unquoted
    for (const e of AGENT_WHATS_NEW) expect(whatsNewNotice(V, [e]).includes(SKILL_READ_HINT), e.id).toBe(naming.includes(e));
  });

  function daemonWith(config: Record<string, unknown>, kind: "classic" | "fleet-topic", name = "room-bot") {
    const dir = scratch();
    return new Daemon(name, { working_directory: dir, restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent", ...config } as never,
    dir, true, undefined, undefined, pino({ level: "silent" }) as never, { kind, backend: "codex", model: "default" } as never) as any;
  }
  it("each instance knows its roles: Classic, General, a worker, a coordinator or full worker", () => {
    expect(daemonWith({}, "classic").whatsNewRoles()).toEqual(["classic"]);
    expect(daemonWith({ general_topic: true }, "fleet-topic").whatsNewRoles()).toEqual(["general"]);
    expect(daemonWith({}, "fleet-topic").whatsNewRoles()).toEqual(["worker"]);
    expect(daemonWith({ tool_set: "coordinator" }, "fleet-topic").whatsNewRoles()).toEqual(["worker", "coordinator"]);
    expect(daemonWith({ tool_set: "full" }, "fleet-topic").whatsNewRoles()).toEqual(["worker", "coordinator"]);
  });
  it("a Classic instance's pending notice leaves the General entry out, and records it", () => {
    const d = daemonWith({}, "classic");
    writeFileSync(join(d.instanceDir, "whats-new.json"), JSON.stringify({ v: 1, announced: record.announced, version: "2.2.0" }));
    d.prepareWhatsNew(false, V);
    expect(d.pendingWhatsNew.ids).toContain("2.3-web-settings-for-the-user");
    expect(d.pendingWhatsNew.notice).not.toContain("get_web_settings");
    expect(d.pendingWhatsNew.notice).toContain(SKILL_READ_HINT);
  });
  it("narrowed just before the paste: still only this role's entries; none left → recorded, nothing sent", () => {
    const d = daemonWith({}, "classic");
    writeFileSync(join(d.instanceDir, "whats-new.json"), JSON.stringify({ v: 1, announced: record.announced, version: "2.2.0" }));
    d.prepareWhatsNew(false, V);
    // Everything but the General entry was recorded meanwhile (another notice): nothing this role is told remains.
    const others = AGENT_WHATS_NEW.filter(e => e.id !== "2.3-web-settings-for-the-user").map(e => e.id);
    writeFileSync(join(d.instanceDir, "whats-new.json"), JSON.stringify({ v: 1, announced: others, version: V }));
    expect(d.currentWhatsNew(d.pendingWhatsNew)).toBeNull();
    expect(d.pendingWhatsNew).toBeNull();
    expect((readWhatsNewRecord(d.instanceDir) as { announced: string[] }).announced).toContain("2.3-web-settings-for-the-user");
  });
});
