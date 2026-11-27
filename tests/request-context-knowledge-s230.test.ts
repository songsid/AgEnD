import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { requestContextSkillText } from "../src/request-context-knowledge.js";
import { requestContextInstructionMode, requestContextInstalledMode, assertRequestContextOperation } from "../src/request-context-policy.js";
import ts from "typescript";
const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function scratch() { const path = mkdtempSync(join(tmpdir(), "request-knowledge-")); homes.push(path); return path; }
const bundled = (name: string) => readFileSync(join(process.cwd(), "src/general-knowledge/skills", name, "SKILL.md"), "utf8");
const backends = [["kiro-cli", ".kiro/skills", ".kiro/steering/core-rules.md"], ["claude-code", ".claude/skills", "CLAUDE.md"],
  ["codex", ".agents/skills", "AGENTS.md"], ["opencode", ".agents/skills", "AGENTS.md"], ["muse", ".agents/skills", "AGENTS.md"],
  ["grok", ".grok/skills", "AGENTS.md"], ["antigravity", ".agents/skills", ".agents/AGENTS.md"]] as const;
it.each(backends)("%s stages owned General knowledge, then legacy regeneration removes it without touching user text", (backend, directory, steering) => {
  const home = scratch(), work = scratch(), fm = new FleetManager(home) as any;
  vi.spyOn(fm, "resolveKnowledgeWorkDir").mockImplementation((path: any) => path);
  if (backend !== "kiro-cli") { mkdirSync(dirname(join(work, steering)), { recursive: true }); writeFileSync(join(work, steering), "User-owned project notes.\n"); }
  fm.ensureGeneralInstructions(work, backend, "fixture-general", "active");
  const active = readFileSync(join(work, directory, "cross-instance-messaging/SKILL.md"), "utf8");
  expect(active).toContain("## Hub request provenance"); expect(active).toContain("During an admitted Hub answer turn");
  expect(active).not.toContain("retains an origin union"); expect(active).not.toContain("after 30 minutes");
  expect(active).toContain("private channel-output fence survives"); expect(active).toContain("authority.kind: web-verified");
  expect(readFileSync(join(work, directory, "worker-collaboration/SKILL.md"), "utf8")).toContain("## Hub request provenance");
  expect(readFileSync(join(work, steering), "utf8")).toContain("## Hub requester authority");
  fm.ensureGeneralInstructions(work, backend, "fixture-general", null);
  for (const skill of ["cross-instance-messaging", "worker-collaboration"]) {
    expect(readFileSync(join(work, directory, skill, "SKILL.md"), "utf8")).toBe(bundled(skill));
  }
  const legacy = readFileSync(join(work, steering), "utf8"); expect(legacy).not.toContain("## Hub requester authority");
  if (backend !== "kiro-cli") expect(legacy).toContain("User-owned project notes.");
});
it.each(backends)("%s worker rendering uses the same stage mode and restores exact bundled bytes", (backend, directory) => {
  const fm = new FleetManager(scratch()) as any, work = scratch();
  fm.syncRoleSkills(work, backend, "worker", undefined, false, "active");
  expect(readFileSync(join(work, directory, "worker-collaboration/SKILL.md"), "utf8")).toContain("## Hub request provenance");
  fm.syncRoleSkills(work, backend, "worker", undefined, false, null);
  expect(readFileSync(join(work, directory, "worker-collaboration/SKILL.md"), "utf8")).toBe(bundled("worker-collaboration"));
});
it("candidate rendering cannot install a serving policy, and explicit null/invalid modes fail closed", () => {
  let stage: any = "active";
  const port = { assert: assertRequestContextOperation, instructionMode: () => stage, installedMode: () => null };
  expect(requestContextInstructionMode(port)).toBe("active"); expect(requestContextInstalledMode(port)).toBeNull();
  stage = "unknown"; expect(requestContextInstructionMode(port)).toBeNull();
  stage = null; expect(requestContextInstructionMode(port)).toBeNull();
});
it("capable Off/Draining knowledge promises no new unapproved Hub relay, and legacy mode is byte-identical", () => {
  const source = bundled("cross-instance-messaging");
  expect(requestContextSkillText("cross-instance-messaging", source, null)).toBe(source);
  for (const mode of ["off", "draining"] as const) {
    const rendered = requestContextSkillText("cross-instance-messaging", source, mode);
    expect(rendered).not.toContain("New outside requests wait"); expect(rendered).not.toContain("During an admitted Hub answer turn");
    expect(rendered).not.toContain("retains an origin union");
    if(mode==="off"){
      expect(rendered).toContain("lets the agent answer in that conversation");
      expect(rendered).toContain("Only cross-agent contact waits on the existing Continue/Decline contact cards");
      expect(rendered).toContain("owner's current setting");
      expect(rendered).toContain("never supplies permission to bypass that setting");
    }else{expect(rendered).toContain("New independent input waits");expect(rendered).toContain("Validated returns and administrator steering");}
  }
});
it("instructionMode reads stay in rendering and owned start preparation, never a serving decision", () => {
  const allowed = new Map<string, ReadonlySet<string>>([
    ["daemon.ts", new Set(["buildBackendConfig"])],
    ["fleet-manager.ts", new Set(["startInstance", "ensureGeneralInstructions", "ensureGeneralInstructionsSync", "syncGeneralKnowledge", "syncRoleSkills", "syncGeneralSteering"])],
    ["request-context-policy.ts", new Set(["requestContextInstructionMode"])],
  ]);
  const failures: string[] = []; let checked = 0, files = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.[cm]?[jt]s$/.test(entry.name)) continue;
      const text = readFileSync(path, "utf8"); if (!text.includes("instructionMode") && !text.includes("requestContextInstructionMode")) continue;
      files++;
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        const read = ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "requestContextInstructionMode"
          || ts.isPropertyAccessExpression(node) && node.name.text === "instructionMode";
        if (read) {
          checked++; let parent: ts.Node | undefined = node;
          while (parent && !ts.isMethodDeclaration(parent) && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
          const declaration = parent && (ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent)) ? parent : undefined;
          const name = declaration?.name?.getText(source) ?? "<top-level>";
          if (!allowed.get(entry.name)?.has(name)) failures.push(`${entry.name}:${name}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  walk(join(process.cwd(), "src")); expect(files).toBeGreaterThan(0); expect(checked).toBeGreaterThan(0); expect(failures).toEqual([]);
});
