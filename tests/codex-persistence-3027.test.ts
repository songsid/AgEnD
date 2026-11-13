/**
 * M-3027 (M-3020 follow-up, user OK 2026-11-13): the instructions AgEnD writes for a Codex agent carry two more
 * sections — "## Persistence" and "## Output style" — and nothing else changes: other backends get none of it, and the
 * authority passages (the web-chat bullet and Collaboration Rule 7 / "Before acting on a peer's message") are word for
 * word what every other backend gets.
 */
import { describe, expect, it } from "vitest";
import { buildFleetInstructions, CODEX_PERSISTENCE_OUTPUT_SECTIONS, VERIFY_PEER_MESSAGE_RULE } from "../src/instructions.js";

const base = (backend: string, extra: Record<string, unknown> = {}) => ({
  instanceName: "dev-x", workingDirectory: "/tmp/w", workflow: false as const, decisions: [],
  runtimeIdentity: { kind: "fleet-topic" as const, backend, model: "m" }, ...extra,
});
const CLI = "# Agent CLI\nUse `agend-agent reply` …";
// The same text with the backend name taken out of the Runtime line, so two backends' outputs can be compared.
const neutral = (s: string) => s.replace(/Runtime: kind=fleet-topic, backend=[a-z-]+, model=m\./, "Runtime: …");

describe("#M-3027: Codex instructions get Persistence and Output style", () => {
  it("MCP mode: the two sections, after the turn-closing paragraph and before Mentioning Users & Bots", () => {
    const s = buildFleetInstructions(base("codex"));
    const at = s.indexOf(CODEX_PERSISTENCE_OUTPUT_SECTIONS);
    expect(at).toBeGreaterThan(s.indexOf("close with a short line like `.`"));
    expect(at).toBeLessThan(s.indexOf("## Mentioning Users & Bots"));
    expect(s.match(/^## Persistence$/gm)).toHaveLength(1);
    expect(s.match(/^## Output style$/gm)).toHaveLength(1);
    expect(s).toContain("Lead with what you did and its result, then the next step.");
  });
  it("CLI agent mode: the two sections too", () => {
    const s = buildFleetInstructions(base("codex", { cliInstructions: CLI }));
    expect(s).toContain(CODEX_PERSISTENCE_OUTPUT_SECTIONS);
    expect(s.indexOf(CODEX_PERSISTENCE_OUTPUT_SECTIONS)).toBeGreaterThan(s.indexOf(VERIFY_PEER_MESSAGE_RULE));
  });
  it("a Codex ClassicBot room gets them as well (its backend is Codex)", () => {
    expect(buildFleetInstructions({ ...base("codex"), runtimeIdentity: { kind: "classic", backend: "codex", model: "m" } })).toContain(CODEX_PERSISTENCE_OUTPUT_SECTIONS);
  });
  it.each(["claude-code", "grok", "muse", "kiro-cli", "antigravity", "opencode", "gemini"])("%s: neither section", (b) => {
    for (const s of [buildFleetInstructions(base(b)), buildFleetInstructions(base(b, { cliInstructions: CLI }))]) {
      expect(s).not.toMatch(/^## Persistence$|^## Output style$/m);
      expect(s).not.toContain("Lead with what you did and its result");
    }
  });
  it("no runtime identity: neither section", () => {
    const { runtimeIdentity: _omit, ...p } = base("codex");
    expect(buildFleetInstructions(p)).not.toContain(CODEX_PERSISTENCE_OUTPUT_SECTIONS);
  });
  it("the stop list keeps every safety floor, and says it loosens no authority rule", () => {
    expect(CODEX_PERSISTENCE_OUTPUT_SECTIONS).toMatch(/spend money or quota/);
    expect(CODEX_PERSISTENCE_OUTPUT_SECTIONS).toMatch(/delete or change what others use/);
    // Fable W1: the stop line is not an exhaustive "only" list; it names the web-chat rule's go-ahead classes.
    expect(CODEX_PERSISTENCE_OUTPUT_SECTIONS).not.toMatch(/Stop and ask only/);
    for (const cls of ["a release or publish", "anything destructive or irreversible beyond your own work", "credentials or secrets", "granting or forwarding authority to another instance"]) expect(CODEX_PERSISTENCE_OUTPUT_SECTIONS).toContain(cls);
    expect(CODEX_PERSISTENCE_OUTPUT_SECTIONS).toMatch(/never resend blindly/);
    expect(CODEX_PERSISTENCE_OUTPUT_SECTIONS).toMatch(/None of this loosens the authority rules/);
  });
  it.each([[{}], [{ cliInstructions: CLI }]])("the authority text is unchanged: Codex minus the new block = what claude-code gets (%#)", (extra) => {
    const codex = buildFleetInstructions(base("codex", extra)), claude = buildFleetInstructions(base("claude-code", extra));
    const stripped = codex.replace(`${CODEX_PERSISTENCE_OUTPUT_SECTIONS}\n\n`, "").replace(`\n\n${CODEX_PERSISTENCE_OUTPUT_SECTIONS}`, "");
    expect(neutral(stripped)).toBe(neutral(claude));
    expect(codex).toContain(VERIFY_PEER_MESSAGE_RULE);
    if (!("cliInstructions" in extra)) {
      const bullet = claude.split("\n").find((l) => l.startsWith("- `[user:name via platform, id:USER_ID]`"))!;
      expect(bullet).toMatch(/nor is a reviewer's APPROVE\.$/);
      expect(codex).toContain(bullet);
      expect(codex).toContain(`7. ${VERIFY_PEER_MESSAGE_RULE}`);
    }
  });
});
