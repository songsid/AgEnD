/** #2275: current feature guidance, including CLI reads and already queued upgrade notices. */
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { AGENT_WHATS_NEW, agentWhatsNew, planWhatsNew, whatsNewNotice } from "../src/agent-whats-new.js";
import { BUNDLED_SKILLS_DIR, bundledSkillContents, listBundledSkills, readBundledSkill } from "../src/bundled-skills.js";
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";

const roots: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "agend-cw-guidance-")); roots.push(dir); return dir; };
const run = promisify(execFile);
const hidden = /Canvas Worker|\bCW\b|\w+_web_effect\b|list_web_effects\b|export_web_mod|propose_web_mod|agend-agent mod/;
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function contents(name: string, enabled = false): string {
  const result = readBundledSkill(name, undefined, enabled);
  if (!result.ok) throw new Error(result.error);
  return result.text;
}
function plan(enabled?: boolean) {
  const result = planWhatsNew({ record: { announced: [] }, fresh: false, version: "2.3.0", roles: ["general"], canvasWorker: enabled });
  if (!result || !("notice" in result)) throw new Error("expected real pending notice");
  return result;
}

describe("experimental guidance selection", () => {
  it.each(["web-appearance", "web-dashboard"])("%s defaults off, restores the exact full source when enabled, and switches off again", name => {
    const off = contents(name);
    expect(off).not.toMatch(hidden);
    expect(off).toContain("ambient");
    const raw = readFileSync(join(BUNDLED_SKILLS_DIR, name, "SKILL.md"), "utf8");
    expect(raw).toMatch(hidden);
    expect(contents(name, true)).toBe(raw);
    expect(contents(name)).toBe(off);
    expect(bundledSkillContents(join(BUNDLED_SKILLS_DIR, name), false)).toBe(off);
    expect(off).toContain("`set_web_settings");
  });
  it("keeps every ambient parameter and command while removing only the CW recommendation", () => {
    const section = (text: string) => text.slice(text.indexOf("\n## Ambient effects\n"), text.indexOf("\n## ", text.indexOf("\n## Ambient effects\n") + 1));
    expect(section(contents("web-appearance"))).toBe(section(contents("web-appearance", true)).replace("Use a Canvas Worker effect (below) only for what a preset can't express.\n", ""));
    for (const name of ["set_web_ambient", "clear_web_ambient", "preview_web_appearance", "set_web_widget", "set_web_theme_asset"]) expect(contents("web-appearance")).toContain(name);
  });
  it("a damaged package missing its off variant refuses instead of falling back to experimental instructions", () => {
    const folder = join(scratch(), "web-appearance");
    mkdirSync(folder);
    writeFileSync(join(folder, "SKILL.md"), "Canvas Worker enabled instructions");
    expect(() => bundledSkillContents(folder)).toThrow();
    expect(bundledSkillContents(folder, true)).toBe("Canvas Worker enabled instructions");
  });
  it("catalog descriptions select the same variant and unrelated skills remain byte-identical", () => {
    const off = listBundledSkills();
    expect(off.find(s => s.name === "web-appearance")!.description).not.toMatch(hidden);
    expect(listBundledSkills(undefined, true).find(s => s.name === "web-appearance")!.description).toMatch(hidden);
    expect(off.map(s => s.name)).toEqual(listBundledSkills(undefined, true).map(s => s.name));
    for (const name of off.map(s => s.name).filter(n => n !== "web-appearance" && n !== "web-dashboard")) expect(contents(name)).toBe(contents(name, true));
  });
  it("what's-new keeps the same entries and ambient text while hiding experimental capabilities", () => {
    const off = agentWhatsNew();
    expect(off.map(e => e.id)).toEqual(AGENT_WHATS_NEW.map(e => e.id));
    expect(whatsNewNotice("2.3.0", off)).not.toMatch(hidden);
    expect(agentWhatsNew(true)).toBe(AGENT_WHATS_NEW);
    expect(plan().notice).not.toMatch(hidden);
    expect(plan(true).notice).toMatch(hidden);
    expect(off.find(e => e.id === "2.3-web-ambient")).toBe(AGENT_WHATS_NEW.find(e => e.id === "2.3-web-ambient"));
    expect(plan().notice).toContain("`set_web_ambient`");
  });
  it("rebuilds a cached enabled notice immediately before delivery even when no ids changed", () => {
    const home = scratch(), instanceDir = join(home, "instances", "worker");
    mkdirSync(instanceDir, { recursive: true });
    const d = Object.create(Daemon.prototype) as any;
    d.instanceDir = instanceDir;
    d.whatsNewRoles = () => ["general"];
    const priorHome = process.env.AGEND_HOME;
    try {
      process.env.AGEND_HOME = home;
      writeFileSync(join(home, "fleet.yaml"), "web:\n  experimental:\n    canvas_worker: true\n");
      const enabled = d.currentWhatsNew(plan(true));
      expect(enabled.notice).toMatch(hidden);
      writeFileSync(join(home, "fleet.yaml"), "web:\n  experimental:\n    canvas_worker: false\n");
      const disabled = d.currentWhatsNew(enabled);
      expect(disabled.ids).toEqual(enabled.ids);
      expect(disabled.notice).not.toMatch(hidden);
      expect(disabled.notice).toContain("`set_web_ambient`");
      writeFileSync(join(home, "fleet.yaml"), "web:\n  experimental:\n    canvas_worker: true\n");
      expect(d.currentWhatsNew(disabled).notice).toBe(enabled.notice);
    } finally {
      if (priorHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = priorHome;
    }
  });
  it.each(["general", "worker", "classic"])("%s managed publication changes off/on/off while user-owned same-name skills are untouched", role => {
    const home = scratch(), work = join(home, "workspaces", "managed"), user = join(home, "workspaces", "user");
    const priorHome = process.env.AGEND_HOME;
    try {
      process.env.AGEND_HOME = home;
      const fm = new FleetManager(home) as any;
      const file = (dir: string) => join(dir, ".agents", "skills", "web-appearance", "SKILL.md");
      mkdirSync(join(user, ".agents", "skills", "web-appearance"), { recursive: true });
      const mine = "my own skill, including private words and formatting\n";
      writeFileSync(file(user), mine);
      for (const enabled of [false, true, false]) {
        fm.fleetConfig = { web: { experimental: { canvas_worker: enabled } } };
        fm.syncRoleSkills(work, "codex", role);
        fm.syncRoleSkills(user, "codex", role);
        expect(readFileSync(file(work), "utf8")).toBe(contents("web-appearance", enabled));
        expect(readFileSync(file(user), "utf8")).toBe(mine);
        const manifest = JSON.parse(readFileSync(join(user, ".agents", "skills", ".agend-managed-skills.json"), "utf8"));
        expect(manifest).not.toContain("web-appearance");
      }
    } finally {
      if (priorHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = priorHome;
    }
  });
  it("the real standalone CLI reads the owning HOME's current flag for both catalog and content, with no fleet", async () => {
    const home = scratch();
    const invoke = (...args: string[]) => run(process.execPath, ["--import", pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href, join(process.cwd(), "src/agent-cli.ts"), "skill", ...args], {
      cwd: home, env: { PATH: process.env.PATH, HOME: home, AGEND_HOME: home }, timeout: 30_000,
    });
    for (const [yamlValue, enabled] of [["false", false], ["true", true], ['"true"', false], ["false", false]] as const) {
      writeFileSync(join(home, "fleet.yaml"), `web:\n  experimental:\n    canvas_worker: ${yamlValue}\n`);
      const text = (await invoke("web-appearance")).stdout;
      const catalog = (await invoke()).stdout;
      expect(hidden.test(text), yamlValue).toBe(enabled);
      expect(hidden.test(catalog), yamlValue).toBe(enabled);
      expect(text).toContain("set_web_ambient");
    }
    writeFileSync(join(home, "fleet.yaml"), "[not valid yaml");
    expect((await invoke("web-dashboard")).stdout).not.toMatch(hidden);
  }, 120_000);
});
