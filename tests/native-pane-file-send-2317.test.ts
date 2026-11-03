/**
 * M-2296 on the alpha (leader bcast-1793723111547): a native Windows Claude pane takes the connector file-send card
 * from the same ClaudePaneDetectors set, so it is held there too — no keys, delivery blocked, input blocked — and the
 * native pane's composer proof (any matching dialog refuses it) never lets a delivery's Enter answer it.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createNativePaneBackend } from "../src/backend/native-pane.js";

const dir = join(__dirname, "fixtures");
const fx = (name: string) => readFileSync(join(dir, `${name}.pane.txt`), "utf8");
const state = () => ({ sessionId: "11111111-1111-4111-8111-111111111111", contextPercentage: 23, statusLineItems: null, resumes: false, cwd: "C:\\fixture" });
const backend = createNativePaneBackend("claude-code", state);
const matching = (pane: string) => backend.getRuntimeDialogs!().filter(d => { d.pattern.lastIndex = 0; return d.pattern.test(pane) && (!d.isActive || d.isActive(pane)); });
const DESCRIPTION = "Claude connector file-send approval — waiting for a human choice, never auto-approving";
const CARDS = ["claude-2.1.317-file-send-card", "claude-2.1.317-file-send-default-no", "claude-2.1.317-file-send-unlisted", "claude-2.1.317-file-send-too-short"];
// A Windows pane names Windows paths.
const windows = (pane: string) => pane.replaceAll("/scratch/cwd/report.pdf", "C:\\Users\\scratch\\report.pdf").replaceAll("/scratch/cwd", "C:\\fixture");

describe("M-2296 native Windows pane: the connector file-send card", () => {
  it.each(CARDS)("%s (Windows paths) is held by the native pane's dialog set, with no keys", name => {
    const pane = windows(fx(name));
    const hits = matching(pane);
    expect(hits.map(d => d.description)).toContain(DESCRIPTION);
    const dialog = hits.find(d => d.description === DESCRIPTION)!;
    expect(dialog.keys).toEqual([]);
    expect([dialog.holdOnly, dialog.blocksDelivery, dialog.inputBlocked]).toEqual([true, true, true]);
    // The first matching entry is the hold, never the dangerous-command auto-No.
    expect(hits[0]!.description).toBe(DESCRIPTION);
    expect(hits.some(d => d.interactionKind === "dangerous_command")).toBe(false);
  });

  it("no ordinary Claude screen in the fixtures is taken for it on a native pane", () => {
    const others = readdirSync(dir).filter(f => f.startsWith("claude") && f.endsWith(".txt") && !CARDS.some(n => f.startsWith(n)));
    expect(others.length).toBeGreaterThan(300);
    expect(others.filter(f => matching(readFileSync(join(dir, f), "utf8")).some(d => d.description === DESCRIPTION))).toEqual([]);
  });
});
