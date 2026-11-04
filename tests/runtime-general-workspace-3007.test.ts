/** Real bounded filesystem publisher; own temporary program/workspace files only, no process or account access. */
import { afterEach, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { GENERAL_KNOWLEDGE_FILES, GENERAL_ROLE_INSTRUCTIONS } from "../src/general-role.js";
import { RuntimeGeneralWorkspace, loadGeneralKnowledge } from "../src/runtime-general-workspace.js";
import { validateGeneralWorkspaceReceipt, validateGeneralWorkspaceRequest, type GeneralWorkspaceRequest } from "../src/runtime-general-protocol.js";
import { validateRuntimePaneRequest } from "../src/runtime-pane-protocol.js";

const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(cli: "codex" | "claude-code" = "codex") {
  const root = mkdtempSync(join(tmpdir(), "general-workspace-")); roots.push(root);
  const program = join(root, "program"), profile = join(root, "profile"); mkdirSync(profile); mkdirSync(program);
  for (const name of GENERAL_KNOWLEDGE_FILES) { const dest = join(program, "general-knowledge", name); mkdirSync(dirname(dest), { recursive: true }); cpSync(join(resolve("src/general-knowledge"), name), dest); }
  const publisher = new RuntimeGeneralWorkspace(profile, program);
  const request = (): GeneralWorkspaceRequest => ({ action: "general-workspace", bindingId, instance: "general-chat", cli, packHash: loadGeneralKnowledge(cli, program).hash });
  const bindingId = randomUUID(), cwd = join(profile, "general-workspaces", bindingId), owned = join(cwd, ".agend-general.json");
  return { root, program, profile, publisher, request, cwd, owned, bindingId, instructions: cli === "codex" ? "AGENTS.md" : "CLAUDE.md", skills: cli === "codex" ? ".agents" : ".claude" };
}
it.each(["codex", "claude-code"] as const)("%s gets the bundled General role and only its native project skill paths", cli => {
  const f = fixture(cli), request = f.request(), result = f.publisher.prepare(request, () => true, () => true);
  expect(result).toMatchObject({ version: 1, bindingId: f.bindingId, instance: "general-chat", packHash: request.packHash, cwd: f.cwd });
  expect(readFileSync(join(f.cwd, f.instructions), "utf8")).toContain(GENERAL_ROLE_INSTRUCTIONS);
  expect(readFileSync(join(f.cwd, f.skills, "skills/delegation-playbook/SKILL.md"), "utf8")).toContain("roles: [general]");
  expect(existsSync(join(f.cwd, cli === "codex" ? ".claude" : ".agents"))).toBe(false);
  const time = statSync(join(f.cwd, f.instructions)).mtimeMs;
  expect(f.publisher.prepare(request, () => true, () => false)).toEqual(result); expect(statSync(join(f.cwd, f.instructions)).mtimeMs).toBe(time);
  expect(() => f.publisher.verify(request, join(f.cwd, "other"))).toThrow("directory differs");
});
it("an incompatible or expired publication makes no workspace", () => {
  const f = fixture(); expect(() => f.publisher.prepare({ ...f.request(), packHash: "a".repeat(64) }, () => true, () => true)).toThrow();
  expect(() => f.publisher.prepare(f.request(), () => false, () => true)).toThrow(); expect(existsSync(f.cwd)).toBe(false);
});
it("an interrupted publication resumes from its receipt without adopting unowned bytes", () => {
  const f = fixture(), first = f.request();
  expect(() => f.publisher.prepare(first, () => !existsSync(join(f.cwd, f.instructions)), () => true)).toThrow("lease expired");
  expect(JSON.parse(readFileSync(f.owned, "utf8")).previous).toEqual({});
  const time = statSync(join(f.cwd, f.instructions)).mtimeMs;
  expect(f.publisher.prepare(first, () => true, () => true).packHash).toBe(first.packHash); expect(statSync(join(f.cwd, f.instructions)).mtimeMs).toBe(time);
});
it("an interrupted old bundle can finish with current bundled content and a stable workspace", () => {
  const f = fixture(); expect(() => f.publisher.prepare(f.request(), () => !existsSync(join(f.cwd, f.instructions)), () => true)).toThrow();
  const source = join(f.program, "general-knowledge/steering/core-rules.md"); writeFileSync(source, readFileSync(source, "utf8") + "\nUpdated installed rule.\n");
  const request = f.request(); expect(f.publisher.prepare(request, () => true, () => true).cwd).toBe(f.cwd);
  expect(f.publisher.verify(request).packHash).toBe(request.packHash); expect(readFileSync(join(f.cwd, f.instructions), "utf8")).toContain("Updated installed rule.");
});
it("live and unknown panes cannot receive a changed pack until their exit is proven", () => {
  const f = fixture(); f.publisher.prepare(f.request(), () => true, () => true); const before = readFileSync(f.owned, "utf8");
  writeFileSync(join(f.program, "general-knowledge/steering/core-rules.md"), "# Updated trusted program rule\n");
  expect(() => f.publisher.prepare(f.request(), () => true, () => false)).toThrow("live or unconfirmed"); expect(readFileSync(f.owned, "utf8")).toBe(before);
  expect(f.publisher.prepare(f.request(), () => true, () => true).cwd).toBe(f.cwd);
});
it("a person-owned instruction file or edited managed file is never overwritten", () => {
  const f = fixture(); mkdirSync(f.cwd, { recursive: true }); const file = join(f.cwd, f.instructions); writeFileSync(file, "person's file");
  expect(() => f.publisher.prepare(f.request(), () => true, () => true)).toThrow("unowned"); expect(readFileSync(file, "utf8")).toBe("person's file");
  rmSync(file); f.publisher.prepare(f.request(), () => true, () => true); writeFileSync(file, "changed by person");
  expect(() => f.publisher.prepare(f.request(), () => true, () => true)).toThrow("unchanged owned"); expect(readFileSync(file, "utf8")).toBe("changed by person");
});
it.each(["manifest", "instructions", "skill-parent", "binding"])("a %s link cannot publish outside the dedicated workspace", kind => {
  const f = fixture(); f.publisher.prepare(f.request(), () => true, () => true); const outside = join(f.root, "outside"); mkdirSync(outside); const sentinel = join(outside, "sentinel"); writeFileSync(sentinel, "keep");
  const target = kind === "manifest" ? f.owned : kind === "instructions" ? join(f.cwd, f.instructions) : kind === "skill-parent" ? join(f.cwd, f.skills) : f.cwd;
  rmSync(target, { recursive: true, force: true }); symlinkSync(kind === "instructions" || kind === "manifest" ? sentinel : outside, target, kind === "instructions" || kind === "manifest" ? "file" : "dir");
  expect(() => f.publisher.prepare(f.request(), () => true, () => true)).toThrow(); expect(readFileSync(sentinel, "utf8")).toBe("keep");
});
it.each([false, [], { "../escape": "a".repeat(64) }])("malformed publication ownership %j refuses instead of adopting it", previous => {
  const f = fixture(); f.publisher.prepare(f.request(), () => true, () => true); const value = JSON.parse(readFileSync(f.owned, "utf8")); value.previous = previous; writeFileSync(f.owned, JSON.stringify(value));
  expect(() => f.publisher.prepare(f.request(), () => true, () => true)).toThrow();
});
it("a binding cannot be reused for another General or provider", () => {
  const f = fixture(); f.publisher.prepare(f.request(), () => true, () => true);
  expect(() => f.publisher.prepare({ ...f.request(), instance: "different" }, () => true, () => true)).toThrow("scope differs");
  expect(() => f.publisher.prepare({ ...f.request(), cli: "claude-code", packHash: loadGeneralKnowledge("claude-code", f.program).hash }, () => true, () => true)).toThrow("scope differs");
});
it("the wire request accepts only fixed publication identities and an exact Windows receipt", () => {
  const f = fixture(), request = f.request(); expect(validateRuntimePaneRequest(request)).toEqual(request);
  for (const raw of [{ ...request, bindingId: [request.bindingId] }, { ...request, cli: ["codex"] }, { ...request, cwd: "C:\\outside" }, { ...request, files: {} }, { ...request, command: "shell" }, { ...request, packHash: [request.packHash] }]) expect(() => validateGeneralWorkspaceRequest(raw)).toThrow();
  const good = { version: 1, bindingId: request.bindingId, instance: request.instance, cli: request.cli, packHash: request.packHash, cwd: "C:\\owned" };
  expect(validateGeneralWorkspaceReceipt(good, request)).toEqual(good);
  for (const raw of [{ ...good, cwd: "../outside" }, { ...good, bindingId: randomUUID() }, { ...good, cli: "claude-code" }, { ...good, token: "not-accepted" }]) expect(() => validateGeneralWorkspaceReceipt(raw, request)).toThrow();
});
