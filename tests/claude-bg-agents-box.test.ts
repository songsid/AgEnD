/**
 * Claude's input box under its background agents' session list (claude 2.1.311 on the leader, 2026-10-27).
 *
 * While background agents run, Claude paints `● main` and one `◯ <agent> … 3m 6s · ↓ 56.8k tokens` row per agent under
 * the box's footer. Counted as footer rows, two agents (or one plus the "paste again to expand" hint) hid the box: no
 * native-queue hand-off and no steer, so every delivery waited for idle — which a pane whose agent timers tick every
 * second never shows — and held the leader's lane for 11 minutes.
 *
 * The fixtures are frames of the leader's recorded pane (output.log replayed into a private tmux at 120×36; the rows
 * above the box replaced with neutral text, and two cells of an earlier frame's residue in the replay cleared).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { ClaudeCodeBackend, readClaudeInputBox } from "../src/backend/claude-code.js";

const pane = (name: string) => readFileSync(join(__dirname, "fixtures", `claude-2.1.311-${name}.pane.txt`), "utf8");

describe("readClaudeInputBox under the background agents' session list", () => {
  it.each([
    // A plain capture cannot tell Claude's dim prompt suggestion ("進度") from typing; that is as before this change.
    ["bg-agent-one-idle", { text: "進度", collapsedPastes: 0 }],
    ["bg-agents-two-waiting", { text: "進度", collapsedPastes: 0 }],
    ["bg-agents-three-busy", { text: "", collapsedPastes: 0 }],
    ["bg-agent-queued-hint", { text: "", collapsedPastes: 0, queued: true }],
  ])("%s", (name, box) => {
    expect(readClaudeInputBox(pane(name))).toEqual(box);
  });

  const lines = (name: string) => pane(name).replace(/\n+$/, "").split("\n");
  const join_ = (rows: string[]) => `${rows.join("\n")}\n`;

  it("one agent more or less never changes the reading", () => {
    const rows = lines("bg-agents-three-busy");
    const agent = rows[rows.length - 1]!;
    for (const extra of [0, 1, 5, 12]) {
      expect(readClaudeInputBox(join_([...rows, ...Array(extra).fill(agent)]))).toEqual({ text: "", collapsedPastes: 0 });
    }
  });

  it("only Claude's list is skipped: no filled row, two filled rows, a lone row or another row under it is not one", () => {
    const rows = lines("bg-agents-three-busy");
    const main = rows.findIndex(r => r === "  ● main");
    const head = rows.slice(0, main);
    const agent = rows[rows.length - 1]!;
    // All of these leave five or more rows under the box that are not the list: the reader stays closed (null).
    expect(readClaudeInputBox(join_([...head, agent, agent, agent]))).toBeNull();                       // no `●`
    expect(readClaudeInputBox(join_([...head, "  ● main", "  ● other", agent, agent]))).toBeNull();     // two `●`
    expect(readClaudeInputBox(join_([...head, "  ● main", agent, agent, "  some other row"]))).toBeNull();
    expect(readClaudeInputBox(join_([...head.slice(0, -1), "  hint", "  another", "", "  ● main"]))).toBeNull();
    expect(readClaudeInputBox(join_([...head, "● main", ...Array(3).fill(agent.trimStart())]))).toBeNull();    // not indented
  });

  it("without the list the footer bound still holds (five rows under the box is not the live box)", () => {
    const rows = lines("bg-agents-three-busy");
    const main = rows.findIndex(r => r === "  ● main");
    expect(readClaudeInputBox(join_([...rows.slice(0, main), "  one", "  two", "  three"]))).toBeNull();
  });
});

describe("the daemon's hand-off gate on those frames", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } } as any;

  // The gate a native-queue hand-off and a steer both pass (hasPositiveDeliveryInput(true)): the box must read.
  it.each(["bg-agents-two-waiting", "bg-agents-three-busy", "bg-agent-queued-hint"])("%s: the box reads, so a busy pane can take the hand-off", async name => {
    const root = mkdtempSync(join(tmpdir(), "agend-bg-agents-")); roots.push(root);
    const instanceDir = join(root, "instances", "worker");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "window-id"), "@worker");
    const daemon: any = new Daemon("worker", {
      working_directory: root, log_level: "error", backend: "claude-code",
      restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
    }, instanceDir, false, new ClaudeCodeBackend(instanceDir) as any,
    { getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => false } as any, logger);
    daemon.tmux = { capturePane: vi.fn(async () => pane(name)), getWindowId: () => "@worker" };
    vi.spyOn(daemon, "needsStartupInputProof").mockReturnValue(false);
    expect(await daemon.hasPositiveDeliveryInput(true)).toBe(true);
  });
});
