import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CodexPaneDetectors } from "../src/backend/codex.js";
import { codexPolicyRecourseVisible, codexPolicyRecourseCard, CODEX_POLICY_RECOURSE_TITLE } from "../src/backend/codex-policy-recourse.js";
import { deriveNeedsYou, type NeedsYouInputs } from "../src/needs-you.js";
import { judgeAssignee, livenessSettings, stoppedLine } from "../src/dispatcher-liveness.js";
import { FleetManager } from "../src/fleet-manager.js";
import { remoteCardPrompt } from "../src/remote-card-prompt.js";
import { answerRemoteCard, type RemoteCardKey } from "../src/remote-card-answer.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
      expect(matches[0]!.requestIdentity!(pane)).toBe(codexPolicyRecourseCard(pane)!.identity);
      expect(matches[0]!.remoteCard!(pane)).toMatchObject({ humanOnly: true, policyRecourse: true, noSkip: true, freeText: false });
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


it("R1 binds every actual choice, not the cursor or a code-owned replacement seed", () => {
  const pane = frames[0]!, card = codexPolicyRecourseCard(pane)!;
  expect(card.options.map(o => o.title)).toEqual(["Explain the topic", "Describe safe practices", "Explain the risks", "Give feedback"]);
  const moved = pane.replace("› 1.", "  1.").replace("  2.", "› 2.");
  expect(codexPolicyRecourseCard(moved)!.identity).toBe(card.identity);
  expect(codexPolicyRecourseCard(pane.replace("Explain the topic", "Another rewrite"))!.identity).not.toBe(card.identity);
  try {
    for (const locale of ["en", "zh-TW"] as const) {
      setLocale(locale);
      const prompt = remoteCardPrompt("reviewer", card, "Review helper");
      expect(prompt.message).toContain(locale === "en" ? "Codex's safety check blocked this turn" : "Codex 的安全檢查擋下了這一輪");
      expect(prompt.message).toContain(locale === "en" ? "Pick a suggested rewrite to continue, or hand this work to another agent." : "可以選一個建議的改寫繼續，或把這件工作交給別的 Agent。");
      expect(prompt.message).toContain("Review helper");
      expect(prompt.choices.map(c => c.webLabel)).toEqual(card.options.map(o => `${o.n}. ${o.title}`));
      expect(prompt.choices.map(c => c.action)).toEqual(["opt-1", "opt-2", "opt-3", "opt-4"]);
      expect(prompt.webInput).toBeNull();
    }
  } finally { setLocale("en"); }
});

it("R1 actual remote-card post retains full dashboard labels, one policy item, and human-only answer boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-card-m3804-"));
  const fm = new FleetManager(dir) as any;
  const answer = vi.fn(async () => ({ outcome: "answered" }));
  const adapter = { type: "telegram", notifyAlert: vi.fn(async (_chat: string, _alert: { choices: Array<{ label: string }> }) => ({ messageId: "card-msg", chatId: "fleet-group" })),
    editMessage: vi.fn(async () => {}), editMessageRemoveButtons: vi.fn(async () => {}) };
  fm.fleetConfig = { defaults: {}, channels: [{ id: "tg", type: "telegram", mode: "topic", group_id: "fleet-group", access: { allowed_users: ["alice"] } }],
    instances: { reviewer: { topic_id: "review-topic", working_directory: dir } } };
  fm.adapter = adapter;
  fm.worlds.set("tg", { id: "tg", adapter, groupId: "fleet-group", channelConfig: fm.fleetConfig.channels[0] });
  fm.lifecycle.daemons.set("reviewer", { answerRemoteCard: answer, repostRemoteCard() {} });
  try {
    const long = "A provider option with a label that is deliberately longer than sixty characters to exercise exact dashboard labels";
    const card = codexPolicyRecourseCard(frames[0]!.replace("Explain the topic", long))!;
    await fm.postRemoteCard("reviewer", card);
    const [prompt] = fm.needsYouPrompts();
    expect(prompt.policyRecourse).toBe(true);
    expect(prompt.actions[0].label).toBe("1. " + long);
    expect(adapter.notifyAlert.mock.calls[0]![1].choices[0]!.label.length).toBeLessThanOrEqual(60);
    const all = deriveNeedsYou({ ...inputs({ name: "reviewer", state: "awaiting_input", interaction: { kind: "policy_recourse", since: 1 }, policyTasks: ["M-100 — Review change"] }), prompts: [prompt] });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ type: "prompt", reason: "codex_policy_recourse", detail: "M-100 — Review change" });
    expect(answer).not.toHaveBeenCalled();
    expect((await fm.clickWebPrompt("reviewer", prompt.nonce, "opt-2", undefined, false)).status).toBe(403);
    expect(answer).not.toHaveBeenCalled();
    expect((await fm.clickWebPrompt("reviewer", prompt.nonce, "opt-2", undefined, true)).status).toBe(200);
    expect(answer).toHaveBeenCalledWith(card.identity, { kind: "option", n: 2 });
  } finally { fm.retireRemoteCard("reviewer", null, "test closed"); rmSync(dir, { recursive: true, force: true }); }
});

it("R1 an explicit choice uses verified cursor keys, while changed suggestions receive no key", async () => {
  const original = frames[0]!, identity = codexPolicyRecourseCard(original)!.identity;
  let pane = original, time = 0;
  const keys: RemoteCardKey[] = [];
  const io = { locked: async <T>(fn: () => Promise<T>) => fn(), read: async () => pane,
    key: async (key: RemoteCardKey) => { keys.push(key); if (key === "Down") pane = pane.replace("› 1.", "  1.").replace("  2.", "› 2."); else if (key === "Enter") pane = "› Ask Codex to do anything\nContext 100% left"; return true; },
    paste: async () => { throw Error("no generated seed is pasted"); }, sleep: async (ms: number) => { time += ms; }, now: () => time };
  expect(keys).toEqual([]);
  expect(await answerRemoteCard(io, codexPolicyRecourseCard, identity, { kind: "option", n: 2 })).toEqual({ outcome: "answered" });
  expect(keys).toEqual(["Down", "Enter"]);
  keys.length = 0; pane = original.replace("Explain the topic", "Changed rewrite");
  expect(await answerRemoteCard(io, codexPolicyRecourseCard, identity, { kind: "option", n: 2 })).toEqual({ outcome: "stale" });
  expect(keys).toEqual([]);
});


it("R1 keeps a native wrapped option as one exact button and one immutable request", () => {
  const pane = frames[0]!.replace("1. Explain the topic", "1. Explain the topic with a\n     continued option label");
  const card = codexPolicyRecourseCard(pane)!;
  expect(card.options[0]!.title).toBe("Explain the topic with a continued option label");
  expect(card.options).toHaveLength(4);
  expect(codexPolicyRecourseCard(pane + "\n› Ask Codex to do anything")).toBeNull();
});
