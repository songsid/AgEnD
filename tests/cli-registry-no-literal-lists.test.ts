/**
 * A new hand-written list of CLI ids in `src` fails here. What a CLI can do — sign in, sign out, show an account, show usage, be installed by a
 * Runtime — is answered once, in src/cli-registry.ts, and the lists that used to repeat it are derived from there. A list written out again is how a
 * new CLI came to "sign in, but show no account and no usage".
 *
 * `ALLOWED` is every file that still names two or more CLIs by hand, with how many such lists it has, and why they are not the registry's business:
 * they are about something else (which CLIs run a persistent Windows pane, which write which transcript, display names), or they are behaviour keyed by
 * CLI id whose keys cli-registry-completeness.test.ts checks against the registry. A file not listed here has none; a file with more than its count has a
 * new one. Fewer than the count is fine (lower the number when you notice). To add one on purpose: say why, in the family it belongs to.
 *
 * It reads text (tests/support/cli-literal-lists.ts) and is a review tool, not a proof: a list built some other way is not seen.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { literalListCounts, literalLists } from "./support/cli-literal-lists.js";

const FAMILIES: ReadonlyArray<{ why: string; files: Readonly<Record<string, number>> }> = [
  { why: "Windows agents: which CLIs run a persistent pane or a General workspace, and what a Windows agent may be asked (a different family from sign-in and accounts)", files: {
    "src/agent-runtime-change.ts": 2, "src/native-instance-input.ts": 3, "src/native-mcp.ts": 1, "src/native-pane-manager.ts": 6, "src/runtime-pane-host.ts": 1, "src/runtime-pane-native.ts": 6,
    "src/runtime-pane-protocol.ts": 3, "src/runtime-pane-transcript-protocol.ts": 2, "src/runtime-pane-transcript.ts": 1, "src/runtime-general-protocol.ts": 3, "src/general-binding.ts": 5,
    "src/windows-agents.ts": 2, "src/windows-cli-worker.ts": 2, "src/backend/native-pane.ts": 1, "src/ui/general-location.js": 1, "src/ui/agent-runtime-settings.js": 1, "src/ui/panel-windows-cli.js": 1,
  } },
  { why: "delivery, turn resume, transcripts and usage reports: which CLIs write which kind of transcript or report", files: {
    "src/daemon.ts": 8, "src/delivery-reconciliation.ts": 2, "src/turn-resume.ts": 2, "src/backend/session-signals.ts": 1, "src/cache-ledger.ts": 1, "src/cache-service.ts": 5,
    "src/transcript-sources.ts": 1, "src/usage-report.ts": 2, "src/usage-rollup.ts": 1,
    // Exact structured subagent formats supported by this reader, not CLI account/install capabilities.
    "src/subagent-records.ts": 2, "src/subagent-service.ts": 1,
  } },
  { why: "the names of the backends in configuration checks, schemas, commands and help text", files: {
    "src/config-validator.ts": 2, "src/config.ts": 2, "src/outbound-schemas.ts": 1, "src/backend/types.ts": 2, "src/bug-report-cli.ts": 1, "src/setup-wizard.ts": 1, "src/quickstart-api.ts": 1,
    "src/topic-commands.ts": 2, "src/channel/adapters/discord.ts": 2, "src/tips.ts": 3, "src/cli.ts": 3, "src/ui/panel-fleet.js": 3,
  } },
  { why: "per-backend behaviour switches (steer, effort, MCP mode, the Codex speed field, the flag that stops a Windows CLI updating itself)", files: { "src/steer-capability.ts": 1, "src/backend/launch-effort.ts": 1, "src/ui/settings-model.js": 3, "src/ui/settings-dialogs.js": 1, "src/windows-cli-providers.ts": 2 } },
  { why: "display names, marks and colours, and the vendor commands the Runtime page shows (the standalone setup script cannot import the registry)", files: {
    "src/ui/panel-chat.js": 1, "src/ui/shared/instance-nav.js": 2, "src/ui/fleet-office-model.js": 1, "src/ui/provider-marks.js": 1, "src/ui/shared/panel-view.js": 1, "src/interaction-observation.ts": 3,
    "src/ui/structured-signin.js": 1, "src/ui/runtime-cli-install.js": 1,
  } },
  { why: "model rediscovery: Claude/Codex have explicit scoped credential protocols; other CLIs must have their own registered listing contract", files: { "src/backend/cli-env-probe.ts": 1, "src/runtime-remote-accounts.ts": 1 } },
  { why: "the audited releases of each CLI (AGEND-136): a ledger of facts per CLI id that the Windows pane gate and the Update button read, kept as one table keyed by id (a Record<CliId, …> the compiler completes)", files: { "src/cli-audited.ts": 1 } },
  { why: "code for Kiro that compares its id with the default backend's", files: { "src/kiro-engine-status.ts": 1, "src/kiro-migrate.ts": 2 } },
  { why: "quota notices (which backends have one)", files: { "src/quota-notice-config.ts": 1, "src/ui/settings-quota-notice.js": 1 } },
  { why: "fleet-manager.ts: Windows General workspaces, Kiro-only paths, effort and display switches, and its backend tables", files: { "src/fleet-manager.ts": 11 } },
  { why: "behaviour keyed by CLI id (credential homes, the login hosts a link may point at, usage readers): the keys are checked against the registry by cli-registry-completeness.test.ts", files: {
    "src/backend/credential-profile.ts": 1, "src/login-url.ts": 1, "src/usage/providers.ts": 2,
  } },
  { why: "web-api.ts: the backend names in a request schema, and which CLIs have a workspace follow", files: { "src/web-api.ts": 4 } },
];
const ALLOWED: Record<string, number> = Object.assign({}, ...FAMILIES.map(f => f.files));

describe("no hand-written list of CLIs outside the registry", () => {
  const root = join(import.meta.dirname, "..", "src");

  it("a file has no more lists of CLI ids than it is allowed", () => {
    const counts = literalListCounts(root);
    const over = Object.entries(counts).filter(([file, n]) => n > (ALLOWED[file] ?? 0)).map(([file, n]) => `${file}: ${n} lists, ${ALLOWED[file] ?? 0} allowed`);
    expect(over, `A list of CLI ids written out by hand. Ask the registry instead (src/cli-registry.ts), or — if it is about something else — allow it in this test, with the reason:\n${
      literalLists(root).filter(l => over.some(o => o.startsWith(`${l.file}:`))).map(l => `  ${l.file}:${l.line} [${l.ids.join(", ")}] ${l.text}`).join("\n")}`).toEqual([]);
  });

  it("every file it allows exists (a renamed file does not keep its allowance)", () => {
    const counts = literalListCounts(root);
    expect(Object.keys(ALLOWED).filter(file => !(file in counts) && !existsSync(join(root, "..", file)))).toEqual([]);
  });

  it("catches a new list, on one line or across several, and ignores a file that names one CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-lists-")); mkdirSync(join(dir, "src"));
    try {
      writeFileSync(join(dir, "src", "oneline.ts"), 'export const WANTS = ["claude-code", "grok"];\n');
      writeFileSync(join(dir, "src", "multiline.ts"), 'export const WANTS = [\n  "codex",\n  "kiro-cli",\n];\nexport const BY = {\n  muse: 1,\n  grok: 2,\n};\n');
      writeFileSync(join(dir, "src", "single.ts"), 'export const ONE = "codex";\nconst two = backend === "grok";\n');
      expect(literalListCounts(join(dir, "src"))).toEqual({ "src/oneline.ts": 1, "src/multiline.ts": 2 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("the scanner sees what it is meant to see", () => {
    const counts = literalListCounts(root);
    expect(counts["src/fleet-manager.ts"]).toBeGreaterThan(0);
    expect(counts["src/accounts-view.ts"]).toBeUndefined();               // derived from the registry now
    expect(counts["src/cli-registry.ts"]).toBeUndefined();
    expect(counts["src/cli-spec-codex.ts"]).toBeUndefined();
  });
});


