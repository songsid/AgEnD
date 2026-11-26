import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CodexPaneDetectors } from "../src/backend/codex.js";
import { codexPolicyRecourseVisible, CODEX_POLICY_RECOURSE_TITLE } from "../src/backend/codex-policy-recourse.js";
import { deriveNeedsYou, type NeedsYouInputs } from "../src/needs-you.js";
import { judgeAssignee, livenessSettings, stoppedLine } from "../src/dispatcher-liveness.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";

const frames = ["cyber-recourse", "bio-recourse-narrow"].map(name => readFileSync(new URL(`./fixtures/codex-policy-recourse-m3804/${name}.pane.txt`, import.meta.url), "utf8"));
const detectors = new CodexPaneDetectors();
const active = (dialog: any, pane: string) => dialog.isActive?.(pane) ?? dialog.pattern.test(pane);
const inputs = (instance: any): NeedsYouInputs => ({ prompts: [], instances: [instance], deliveries: [], ownerOf: () => "dc" });

describe("M-3804 provider-policy recourse is an explicit human wait", () => {
  it.each(frames)("native0.169 frame has a dedicated no-key dialog, no rewritten seed", pane => {
    expect(codexPolicyRecourseVisible(pane)).toBe(true);
    for (const table of [detectors.getRuntimeDialogs(), detectors.getStartupDialogs()]) {
      const matches = table.filter(d => active(d, pane));
      expect(matches[0]).toMatchObject({ interactionKind: "policy_recourse", keys: [], holdOnly: true, humanOnly: true, blocksDelivery: true, inputBlocked: true });
      expect(matches.every(d => d.keys.length === 0)).toBe(true);
      expect(matches[0]!.requestIdentity!(pane)).toBe(CODEX_POLICY_RECOURSE_TITLE);
      expect(matches[0]!.remoteCard?.(pane)).toBeUndefined();
      expect(matches[0]!.answeredByAgend).not.toBe(true);
    }
    expect(detectors.isDeliveryInputReadyPane(pane)).toBe(false);
  });

  it("requires exact live title, numbered options, one cursor and bottom footer", () => {
    const pane = frames[0]!;
    for (const bad of [pane.replace(CODEX_POLICY_RECOURSE_TITLE, "Rewrite this chat?"), pane.replace("enter select · esc back", ""),
      pane.replace("› 1.", "  1."), pane.replace("  2.", "› 2."), pane.replace("  2.", "  9."),
      pane + "\n› Ask Codex to do anything\nContext 20% left", pane + "\n• Working (1s · esc to interrupt)"])
      expect(codexPolicyRecourseVisible(bad)).toBe(false);
    expect(codexPolicyRecourseVisible(pane.replace("new chat with", "new chat\n  with"))).toBe(true);
    expect(codexPolicyRecourseVisible("■ context_window_exceeded\n› Ask Codex to do anything\nContext 1% left")).toBe(false);
  });

  it("Needs you carries the agent, plain reason and bounded task metadata; disappearance clears it", () => {
    const instance = { name: "reviewer", state: "awaiting_input", interaction: { kind: "policy_recourse", owner: "boot", episode: 1, since: 10 },
      policyTasks: ["M-100 — Review the proposed change"], interactionSummary: "provider-generated seed must not appear" };
    const [item] = deriveNeedsYou(inputs(instance));
    expect(item).toMatchObject({ type: "awaiting_input", instance: "reviewer", reason: "codex_policy_recourse", detail: "M-100 — Review the proposed change" });
    expect(deriveNeedsYou(inputs({ ...instance, state: "idle" }))).toEqual([]);
    expect(deriveNeedsYou(inputs({ ...instance, policyTasks: Array(10).fill("x".repeat(400)) }))[0]!.detail.length).toBeLessThanOrEqual(486);
  });

  it("dispatcher uses the existing10-minute prompt threshold and identifies task/agent without advising retry", () => {
    const settings = livenessSettings(null), start = 1000;
    const facts = { process: "running" as const, prompt: { since: start, reason: "codex_policy_recourse" as const } };
    expect(judgeAssignee(facts, { claimedAt: start, updatedAt: start }, settings, start + settings.promptMs - 1)).toBeNull();
    const verdict = judgeAssignee(facts, { claimedAt: start, updatedAt: start }, settings, start + settings.promptMs)!;
    expect(verdict).toEqual({ kind: "prompt", since: start, detail: "codex_policy_recourse" });
    try {
      for (const locale of ["en", "zh-TW"] as const) {
        setLocale(locale);
        const text = stoppedLine({ code: "M-100", title: "Review change" }, "reviewer", verdict, start + settings.promptMs);
        expect(text).toContain("M-100"); expect(text).toContain("reviewer");
        expect(text).toMatch(locale === "en" ? /Do not select a rewrite/ : /不要自動選取改寫/);
      }
    } finally { setLocale("en"); }
  });

  it("actual fleet facts and Needs-you projection preserve the policy category and task, not terminal content", () => {
    const presentation = { state: "awaiting_input", interaction: { kind: "policy_recourse", since: 1000, episode: 1 }, interaction_summary: "do not forward" };
    const fm: any = Object.create(FleetManager.prototype);
    const fields = { fleetConfig: { instances: { reviewer: {} } }, instancePresentation: () => presentation,
      lifecycle: { isPaused: () => false }, instanceProcessStatus: new Map(), instanceStateCache: new Map(), livenessGone: new Map(), needsCrashedAt: new Map(), needsPauseCache: new Map(),
      daemons: new Map(), lastWorkingAt: new Map(), livenessTurnEvidence: new Set(), waitingOnFor: () => [],
      interactionWaitKey: () => ({ owner: "boot" }), kiroCompatibilityHolds: new Map(), missingBinaryHold: () => null,
      modelObservationForInstance: () => null, generalLocationAttention: () => null,
      scheduler: { db: { listTasks: () => [{ code: "M-100", title: "Review change" }] } } };
    for (const [key, value] of Object.entries(fields)) Object.defineProperty(fm, key, { value, configurable: true });
    expect(fm.livenessFacts("reviewer").prompt).toEqual({ since: 1000, reason: "codex_policy_recourse" });
    expect(fm.needsYouInstances()[0].policyTasks).toEqual(["M-100 — Review change"]);
  });
});
