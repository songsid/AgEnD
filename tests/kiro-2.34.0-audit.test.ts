/**
 * #2587: kiro-cli 2.34.0 against the audited 2.33.1 (tests/fixtures/kiro-2.34.0-audit/README.md), captured live and
 * offline from both. Every launch screen (V3 workspace trust in a folder and in home, the TUI trust-all-tools
 * confirmation, the legacy start) is unchanged, and AgEnD's answers still lead to the composer. New in 2.34.0: V3 answers
 * an MCP server's elicitation with an "Input requested" card in place of the composer, and main read that pane as an idle
 * composer — a delivery's Enter landed in the card. It is now held for the person, never keyed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeDialog } from "../src/backend/types.js";
import { KIRO_TESTED_MAX, KiroBackend, kiroMcpInputRequestActive, planKiroLaunch, probeKiroCliCompatibility } from "../src/backend/kiro.js";

const DIR = join(import.meta.dirname, "fixtures", "kiro-2.34.0-audit");
const fixture = (name: string) => readFileSync(join(DIR, name), "utf-8");
const pane = (name: string) => fixture(`${name}.pane.txt`);
const HELP_234 = readFileSync(join(import.meta.dirname, "fixtures", "kiro-help", "chat-help-2.34.0.txt"), "utf-8");
const compat = (version = "2.34.0") =>
  probeKiroCliCompatibility("/fake/kiro-cli", (_bin, args) => (args[0] === "--version" ? `kiro-cli ${version}\n` : HELP_234));
const backend = (trustAll = true) => {
  const b = new KiroBackend("/tmp/kiro-234", compat());
  (b as unknown as { activeTrustAll: boolean }).activeTrustAll = trustAll;
  return b;
};
const active = (dialogs: RuntimeDialog[], screen: string) =>
  dialogs.filter(d => (d.isActive ? d.isActive(screen) : (d.pattern.lastIndex = 0, d.pattern.test(screen))));
/** What the daemon does: the first active entry acts. */
const first = (dialogs: RuntimeDialog[], screen: string) => active(dialogs, screen)[0];
const VERSIONS = ["2.33.1", "2.34.0"] as const;
/** The same screen from the two versions: only the version and the per-version scratch folder names differ. */
const same = (name: string) => VERSIONS.map(v => pane(`${name}-${v}`).replace(/2\.3[34]\.[01]/g, "V").replace(/workspace-roots\/[0-9a-f]+/g, "workspace-roots/H"));
const MCP_HOLD = "Kiro MCP server is asking for input — answer it in the instance pane";

describe("kiro-cli 2.33.1 and 2.34.0: every launch screen is unchanged, and AgEnD's answers still lead to the composer", () => {
  it.each(["v3-ws-120", "v3-home-80", "t2-trust-120", "t2-trust-80"])("%s is identical on both versions", (name) => {
    const [before, after] = same(name);
    expect(after).toBe(before);
  });

  it.each(VERSIONS)("%s: V3 workspace trust (folder at 120, home at 80) gets Enter under --trust-all-tools", (version) => {
    for (const name of ["v3-ws-120", "v3-home-80"]) {
      expect(first(backend().getStartupDialogs(), pane(`${name}-${version}`))?.autoResolutionKey, name).toBe("kiro-workspace-trust-confirm");
    }
  });

  it.each(VERSIONS)("%s: the TUI trust-all-tools confirmation gets its known first step at both widths", (version) => {
    for (const width of ["120", "80"]) {
      expect(first(backend().getStartupDialogs(), pane(`t2-trust-${width}-${version}`))?.autoResolutionKey, width).toBe("kiro-trust-all-tools-step");
    }
  });

  it.each(VERSIONS)("%s: the composers AgEnD reached are ready, with nothing held", (version) => {
    for (const name of ["v3-ready-120", "v3-ready-home-80", "t2-ready-120", "mock-ready-120"]) {
      const screen = pane(`${name}-${version}`);
      expect(backend().getReadyPattern().test(screen), name).toBe(true);
      expect(active(backend().getRuntimeDialogs(), screen), name).toEqual([]);
    }
  });

  it.each(VERSIONS)("%s: the legacy UI still stops offline where it always did", (version) => {
    expect(pane(`l1-start-${version}`)).toContain("error: Failed to fetch available models: dispatch failure");
  });
});

describe("kiro-cli 2.34.0: V3's MCP input card (#2587)", () => {
  const cards = ["10-form", "11-form-paste", "12-form-paste-enter", "20-url"];
  const gone = ["13-form-esc", "19-after-turn", "21-url-esc", "30-question", "31-question-esc"];

  it.each(["120", "80"].flatMap(width => cards.map(step => [width, step])))("%s columns, %s: held for the person — no key, no delivery", (width, step) => {
    const screen = pane(`mcp-${width}-${step}-2.34.0`);
    expect(kiroMcpInputRequestActive(screen)).toBe(true);
    const hold = first(backend().getRuntimeDialogs(), screen)!;
    expect(hold.description).toBe(MCP_HOLD);
    expect(hold.keys).toEqual([]);
    expect([hold.holdOnly, hold.blocksDelivery, hold.inputBlocked]).toEqual([true, true, true]);
    // A mid-turn card: the startup table never sees it, and does not act on it.
    expect(active(backend().getStartupDialogs(), screen).map(d => d.description)).not.toContain(MCP_HOLD);
  });

  it.each(["120", "80"].flatMap(width => gone.map(step => [width, step])))("%s columns, %s: no card on screen, nothing held", (width, step) => {
    const screen = pane(`mcp-${width}-${step}-2.34.0`);
    expect(kiroMcpInputRequestActive(screen)).toBe(false);
    expect(active(backend().getRuntimeDialogs(), screen).map(d => d.description)).not.toContain(MCP_HOLD);
  });

  it("without the hold, main read the card as an idle composer — and a delivery's Enter changed it", () => {
    const card = pane("mcp-120-10-form-2.34.0");
    expect(backend().getReadyPattern().test(card)).toBe(true);
    expect(backend().getBusyPattern().test(card)).toBe(false);
    expect(card).toMatch(/^ ❯ Favourite colour \(required\)\n {5}◂ \(none\) ▸$/m);
    // The paste was swallowed; its Enter accepted "(none)" for the required field and moved the cursor on.
    expect(pane("mcp-120-11-form-paste-2.34.0")).toBe(card);
    expect(pane("mcp-120-12-form-paste-enter-2.34.0")).toMatch(/^ {3}Favourite colour \(required\): \(none\)\n ❯ How many\n {5}>$/m);
    // The url card's Enter would pick its default, "Copy URL".
    expect(pane("mcp-120-20-url-2.34.0")).toMatch(/^ ❯ Copy URL$/m);
  });

  it("2.33.1 paints no card for the same requests; its V2 engine does not even advertise elicitation", () => {
    for (const step of ["10-form", "20-url"]) {
      const screen = pane(`mcp-120-${step}-2.33.1`);
      expect(screen).not.toContain("Input requested");
      expect(kiroMcpInputRequestActive(screen)).toBe(false);
    }
    expect(fixture("tui-2.34.0-mcp-input.js.txt")).toContain("Input requested");
    expect(fixture("elicit-eng-v2.mcp-log.txt")).toContain('"capabilities":{},"clientInfo":{"name":"Q DEV CLI"');
    expect(fixture("elicit-eng-v2.mcp-log.txt")).toMatch(/"id":1000,"error":\{"code":-32601,"message":"elicitation\/create"\}/);
    // V3 (both versions) advertises form and url elicitation, and cancels a request outside a tool call at once.
    for (const version of VERSIONS) {
      const log = fixture(`elicit-${version}.mcp-log.txt`);
      expect(log, version).toContain('"capabilities":{"elicitation":{"form":{},"url":{}}}');
      expect(log, version).toContain('{"result":{"action":"cancel"},"jsonrpc":"2.0","id":1000}');
    }
  });

  describe("only the captured shape is the card", () => {
    const card = pane("mcp-120-10-form-2.34.0");
    const rows = card.replace(/\n+$/, "").split("\n");
    const footer = rows.length - 1, header = rows.findIndex(row => row.startsWith(" Input requested · "));
    const edit = (index: number, row: string) => rows.map((r, i) => (i === index ? row : r)).join("\n");
    it("the captured card, and a server name instead of 'MCP server'", () => {
      expect(kiroMcpInputRequestActive(card)).toBe(true);
      expect(kiroMcpInputRequestActive(edit(header, " Input requested · audit-server"))).toBe(true);
    });
    it("a composer below it, or any text after the key hints: history, not a live card", () => {
      expect(kiroMcpInputRequestActive(`${card.replace(/\n+$/, "")}\n› ask a question or describe a task ↵`)).toBe(false);
      expect(kiroMcpInputRequestActive(`${card.replace(/\n+$/, "")}\n  something else`)).toBe(false);
      // A composer row inside the card (one cursor row kept, so only the composer rule can reject it).
      expect(rows[header + 4]).toBe("     ◂ (none) ▸");
      expect(kiroMcpInputRequestActive(edit(header + 4, "› typed"))).toBe(false);
    });
    it("another key-hint row, or another header", () => {
      expect(kiroMcpInputRequestActive(edit(footer, " esc to cancel · ↑↓ to navigate · ↵ to submit"))).toBe(false);
      expect(kiroMcpInputRequestActive(edit(header, " Question"))).toBe(false);
      expect(kiroMcpInputRequestActive(edit(header, " Input requested"))).toBe(false);
    });
    it("a divider missing: above or below the header, or above the key hints", () => {
      expect(kiroMcpInputRequestActive(edit(header - 1, ""))).toBe(false);
      expect(kiroMcpInputRequestActive(edit(header + 1, ""))).toBe(false);
      expect(kiroMcpInputRequestActive(edit(footer - 1, ""))).toBe(false);
    });
    it("no cursor row, or two", () => {
      expect(kiroMcpInputRequestActive(card.replace(" ❯ Favourite colour", "   Favourite colour"))).toBe(false);
      expect(kiroMcpInputRequestActive(card.replace("   How many: empty", " ❯ How many: empty"))).toBe(false);
    });
  });
});

describe("kiro-cli 2.34.0: the precheck's hard findings are not on AgEnD's path", () => {
  it("'Trust this workspace?' in the binary is the new --trust-workspace flag's help; the help adds nothing else", () => {
    const diff = fixture("chat-help-2.33.1-2.34.0.diff");
    expect(diff).toContain('>           Skip the "Trust this workspace?" prompt for this launch only (V3 only). Hooks, agents, MCP');
    const added = diff.split("\n").filter(line => line.startsWith("> ") && line.trim() !== ">").map(line => line.slice(2).trim());
    expect(added.filter(line => !/^(?:Usage: kiro-cli chat|--trust-workspace|Skip the "Trust|servers and workflows|a folder that is not|-v, --verbose|Increase logging)/.test(line))).toEqual([]);
  });

  it("the three unhinted strings exist only in 2.34.0's kiro-cli-chat, beside the flag help, the agent and the uninstaller", () => {
    const hits = fixture("kiro-cli-chat-precheck-hits.strings.txt");
    for (const s of ["'Trust this workspace?'", "'The previous response was interrupted.", "'Are you sure you want to continue uninstalling Kiro CLI?'"]) {
      expect(hits).toMatch(new RegExp(`## 2\\.34\\.0 kiro-cli-chat ${s.replace(/[.?*()[\]]/g, "\\$&")}[^\\n]*count 1`));
      expect(hits).toMatch(new RegExp(`## 2\\.33\\.1 kiro-cli-chat ${s.replace(/[.?*()[\]]/g, "\\$&")}[^\\n]*count 0`));
    }
    expect(hits).toContain("TRUST_WORKSPACESkip the \"Trust this workspace?\" prompt");
    expect(hits).toContain("Uninstalling is only supported for the kiro-cli binary");
  });

  it("2.34.0 is the tested maximum, read from the version table with the same pins as from its own --help", () => {
    expect(KIRO_TESTED_MAX).toBe("2.34.0");
    const table = compat();
    expect(table.source).toBe("version");
    const help = compat("2.34.1");
    expect(help.source).toBe("help");
    expect(help.agentEngines).toEqual(["v2", "v1", "v3"]);
    for (const ui of ["legacy", "tui", "v3"] as const) expect(planKiroLaunch(ui, help), ui).toEqual(planKiroLaunch(ui, table));
  });
});
