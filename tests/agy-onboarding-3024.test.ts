import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { Daemon } from "../src/daemon.js";
import { AntigravityBackend } from "../src/backend/antigravity.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures/agy-onboarding-1.5.6", name + ".pane.txt"), "utf8");
const live = (name: string) => readFileSync(join(import.meta.dirname, "fixtures/agy-onboarding-1.5.7", name + ".pane.txt"), "utf8");
const terms = fixture("terms-checked");
const welcome = fixture("welcome");
const backend = new AntigravityBackend("/nonexistent-agy-3024", "/nonexistent-home", "/nonexistent-agend");
const matches = (d: ReturnType<typeof backend.getStartupDialogs>[number], pane: string) => d.isActive ? d.isActive(pane) : d.pattern.test(pane);
const action = (pane: string, claimed = new Set<string>()) => backend.getStartupDialogs().find(d => matches(d, pane) && !(d.autoResolutionKey && claimed.has(d.autoResolutionKey)));
const off = terms.replace("> [x]", "> [ ]");
// Derived mismatch controls for the screenshot fixture; actual captured frames are exercised below.
const buttons = (checked: boolean, focus: "previous" | "done") => terms.replace("> [x]", checked ? "  [x]" : "  [ ]")
  .replace("[Previous]      [Done]", focus === "previous" ? "> Previous      [Done]" : "[Previous]      > Done")
  .replace("enter Toggle", "enter Confirm");

describe("agy onboarding: each key needs its own freshly verified screen", () => {
  it("keeps the selected terminal scheme and advances without changing colours", () => {
    expect(action(welcome)?.keys).toEqual(["Enter"]);
  });
  it("unticks Interactions exactly once; no repaint must never toggle it back on", () => {
    const first = action(terms);
    expect(first?.keys).toEqual(["Enter"]);
    expect(first?.oncePerLaunch).toBe(true);
    expect(action(terms, new Set([first!.autoResolutionKey!]))?.holdOnly).toBe(true);
  });
  it("an observed unchecked repaint moves focus, never toggles", () => {
    expect(action(off)?.keys).toEqual(["Down"]);
    expect(action(buttons(false, "previous"))?.keys).toEqual(["Right"]);
    expect(action(buttons(false, "done"))?.keys).toEqual(["Enter"]);
  });
  it.each(["previous", "done"] as const)("a checked box with focus on %s can only move back", focus => {
    expect(action(buttons(true, focus))?.keys).toEqual(["Up"]);
  });
  it.each([
    ["missing cursor", terms.replace("> [x]", "  [x]")],
    ["double cursor", terms.replace("[Done]", "> Done")],
    ["changed choice", terms.replace("my Interactions data", "all my files")],
    ["changed checkbox", terms.replace("[x]", "[?]")],
    ["changed Terms link", terms.replace("https://antigravity.google/terms", "https://example.invalid/terms")],
    ["changed privacy link", terms.replace("https://policies.google.com/privacy", "https://example.invalid/privacy")],
    ["extra choice", terms.replace("      Links:", "      [x] Share files\n      Links:")],
    ["unknown footer", terms.replace("enter Toggle", "enter Continue")],
  ])("%s stays held for Needs you without keys", (_name, pane) => {
    expect(action(pane)?.holdOnly).toBe(true);
    expect(action(pane)?.keys).toEqual([]);
  });
  it.each([terms, off, buttons(false, "done"), welcome])("a quoted wizard above a composer never receives keys", pane => {
    expect(action(pane + "\n● Reply\n──────────────────────────────\n>\n──────────────────────────────\nContext 0% used")).toBeUndefined();
  });
  it("startup and runtime share exactly the same verified onboarding phases", () => {
    for (const pane of [terms, off, buttons(false, "previous"), buttons(false, "done"), welcome]) {
      const startup = action(pane)!;
      const runtime = backend.getRuntimeDialogs().find(d => matches(d, pane));
      expect(runtime?.keys).toEqual(startup?.keys);
      expect(runtime?.autoResolutionKey).toBe(startup?.autoResolutionKey);
      expect(runtime?.inputBlocked).toBe(true);
      expect(runtime?.blocksDelivery).toBe(true);
    }
  });
});


describe("real daemon startup admission (mock pane only, no CLI)", () => {
  const dirs: string[] = [];
  afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });
  function rig(initial = terms) {
    const dir = mkdtempSync(join(tmpdir(), "agy-onboarding-3024-")); dirs.push(dir);
    writeFileSync(join(dir, "window-id"), "@1");
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("agy-onboarding", {
      working_directory: dir, backend: "antigravity", restart_policy: {max_retries: 0, backoff: "linear", reset_after: 0}, log_level: "silent",
    } as any, dir, false, new AntigravityBackend(dir, dir, dir), undefined, {child: () => logger} as any) as any;
    const state = {pane: initial, keys: [] as string[], literalKeys: [] as string[], afterCapture: (() => {}) as () => void, afterKey: (_key: string) => {}};
    daemon.tmux = {
      capturePane: vi.fn(async () => { const pane = state.pane; state.afterCapture(); return pane; }),
      isWindowAlive: async () => true,
      sendSpecialKey: vi.fn(async (key: string) => {state.keys.push(key); state.afterKey(key); return true;}),
      sendKeys: vi.fn(async (key: string) => {state.literalKeys.push(key); state.keys.push(key); state.afterKey(key); return true;}),
    };
    daemon.controlClient = {waitForIdle: async () => {}};
    return {daemon, state};
  }
  async function scan(daemon: any) {
    vi.useFakeTimers();
    const result = daemon.dismissDialogsUntilReady(2500, 10);
    await vi.advanceTimersByTimeAsync(3000);
    return await result;
  }
  it("verifies every repaint through completion; preserves existing trust handling", async () => {
    const {daemon, state} = rig(live("welcome"));
    const trust = live("trust");
    const ready = readFileSync(join(import.meta.dirname, "fixtures/agy-1.3.1-idle-after-reply.pane.txt"), "utf8");
    const expected: [string, string, string][] = [
      [live("welcome"), "Enter", live("terms-checked")], [live("terms-checked"), "Enter", live("terms-unchecked")], [live("terms-unchecked"), "Down", live("terms-previous")],
      [live("terms-previous"), "Right", live("terms-done")], [live("terms-done"), "Enter", trust],
      [trust, "Enter", ready],
    ];
    let step = 0;
    state.afterKey = key => { const [before, wanted, after] = expected[step++]!; expect(state.pane).toBe(before); expect(key).toBe(wanted); state.pane = after; };
    expect(await scan(daemon)).toBe(true);
    expect(step).toBe(expected.length);
    expect(state.literalKeys).toEqual([]);
    expect(state.keys).toEqual(["Enter", "Enter", "Down", "Right", "Enter", "Enter"]);
  });
  it("a checkbox that never repaints unchecked receives only one toggle", async () => {
    const {daemon, state} = rig();
    await scan(daemon);
    expect(state.keys).toEqual(["Enter"]);
    const probe = await daemon.probeBlockingDialog();
    expect(probe.state).toBe("dialog");
    expect(probe.dialog.holdOnly).toBe(true);
  });
  it("a changed consent between selection and write-lock capture receives no key", async () => {
    const {daemon, state} = rig();
    state.afterCapture = () => {state.pane = terms.replace("my Interactions data", "all my files");};
    await scan(daemon);
    expect(state.keys).toEqual([]);
  });
  it("a checked repaint between Done selection and the write-lock capture cannot press Done", async () => {
    const {daemon, state} = rig(buttons(false, "done"));
    state.afterCapture = () => {state.pane = buttons(true, "done");};
    await scan(daemon);
    expect(state.keys).not.toContain("Enter");
  });
  it("replacement of the pane owner during the capture retires the scan", async () => {
    const {daemon, state} = rig();
    state.afterCapture = () => {daemon.launchFenceEpoch++;};
    await scan(daemon);
    expect(state.keys).toEqual([]);
  });
});


describe("actual1.5.7 captures from authorised fresh-home sign-in", () => {
  it.each([
    ["welcome", "Enter"], ["terms-checked", "Enter"], ["terms-unchecked", "Down"],
    ["terms-previous", "Right"], ["terms-done", "Enter"], ["trust", "Enter"],
  ])("%s yields only its observed key %s", (name, key) => {
    expect(action(live(name))?.keys).toEqual([key]);
  });
  it("the Done capture with a checked box cannot confirm", () => {
    expect(action(live("terms-done").replace("[ ] Yes", "[x] Yes"))?.keys).toEqual(["Up"]);
  });
  it("an unknown/footer-like appended row or quoted screen receives no key", () => {
    expect(action(live("terms-done") + "\n                      ordinary text\n")).toBeUndefined();
  });
});
