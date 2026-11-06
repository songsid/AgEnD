import { describe, expect, it } from "vitest";
import { HUB_REPORT_TARGET, parseHubReportExtras } from "../src/hub-report-target.js";
import { buttonsDigest, prepareHubAnswerButtons, validHubAnswerButtons } from "../src/hub/buttons-model.js";
import { answerButtonsSchema } from "../src/hub/protocol.js";
import { messageContentDigest } from "../src/hub/identity.js";
import type { HubAnswerButtons } from "../src/hub/types.js";

const parse = (args: Record<string, unknown>) => parseHubReportExtras(HUB_REPORT_TARGET, args);

describe("Hub report buttons use the reply tool's model", () => {
  it("accepts and snapshots labels/values with the reply normalization", () => {
    const buttons = [{ label: " Yes " }, { label: "No", value: "no" }];
    const result = parse({ summary: "Choose", buttons });
    expect(result).toEqual({ ok: true, extras: { buttons: [{ label: "Yes", value: "Yes" }, { label: "No", value: "no" }] } });
    buttons[0]!.label = "changed";
    expect(result).toMatchObject({ extras: { buttons: [{ label: "Yes" }, { label: "No" }] } });
  });
  it("normalizes the poll once from the answer text and raw show_voters field", () => {
    expect(parse({ summary: "Pick\na choice", buttons: [{ label: "A" }, { label: "B" }], poll: { seconds: 10, show_voters: true } })).toEqual({
      ok: true, extras: { buttons: [{ label: "A", value: "A" }, { label: "B", value: "B" }],
        poll: { seconds: 10, multi: false, reveal: "close", showVoters: true, question: "Pick a choice" } },
    });
  });
  it.each([
    { buttons: [{ label: "A" }, { label: "A" }] },
    { buttons: [{ label: "A\nB" }] },
    { buttons: [{ label: "x".repeat(81) }] },
    { buttons: [{ label: "A", value: "x".repeat(201) }] },
    { buttons: Array.from({ length: 11 }, (_, i) => ({ label: String(i) })) },
    { buttons: [{ label: "A" }], poll: { seconds: 10 } },
    { buttons: [{ label: "A" }, { label: "B" }], poll: { seconds: 9 } },
    { poll: { seconds: 10 } },
  ])("refuses malformed reply arguments: %j", args => {
    expect(parse({ summary: "Choose", ...args }).ok).toBe(false);
  });
  it("requires answer text and confines these fields to Hub reports", () => {
    expect(parse({ buttons: [{ label: "A" }] }).ok).toBe(false);
    expect(parseHubReportExtras("another-fleet", { buttons: [{ label: "A" }] }).ok).toBe(false);
    expect(parse({ summary: "Answer", buttons: [], poll: null })).toEqual({ ok: true, extras: {} });
  });
});

const wire = (): HubAnswerButtons => ({ id: "a".repeat(32), labels: ["A", "B"], values: ["a", "b"],
  poll: { seconds: 10, multi: false, reveal: "close", showVoters: false, question: "Choose" } });

describe("exact buttons-v1 payload", () => {
  it("accepts the normalized reply model, including Unicode at the reply limits", () => {
    const b = wire();
    b.poll!.question = "題".repeat(300);
    expect(answerButtonsSchema.safeParse(b).success).toBe(true);
    expect(answerButtonsSchema.safeParse({ id: b.id, labels: ["表".repeat(80)] }).success).toBe(true);
  });
  it.each([
    { id: "A".repeat(32) }, { labels: [] }, { labels: ["A", "A"] }, { labels: [" A", "B"] },
    { values: ["a"] }, { values: ["", "b"] }, { values: ["x".repeat(201), "b"] },
    { labels: ["\ud800", "B"] }, { unexpected: true },
    { poll: { seconds: 10, multi: false, reveal: "close", showVoters: false, question: "A\nB" } },
    { poll: { seconds: 10, multi: false, reveal: "close", showVoters: false, question: "Choose", extra: true } },
  ])("refuses noncanonical or out-of-bounds wire metadata: %j", patch => {
    expect(answerButtonsSchema.safeParse({ ...wire(), ...patch }).success).toBe(false);
  });
  it("freezes a copy before the authorization await", () => {
    const buttons = [{ label: "A", value: "a" }, { label: "B", value: "b" }];
    const poll = wire().poll!;
    const b = prepareHubAnswerButtons(buttons, poll)!;
    const digest = buttonsDigest(b);
    buttons[0]!.label = "changed"; poll.seconds = 60;
    expect(buttonsDigest(b)).toBe(digest);
    expect(b.labels).toEqual(["A", "B"]);
    expect(b.poll!.seconds).toBe(10);
    expect(Object.isFrozen(b)).toBe(true);
    expect(validHubAnswerButtons(b)).toBe(true);
  });
  it("preserves the legacy digest without buttons and binds every choice and poll field when present", () => {
    const b = wire();
    const base = messageContentDigest("answer", "Answer", { buttonsDigest: buttonsDigest(b) });
    const changes: HubAnswerButtons[] = [
      { ...b, id: "b".repeat(32) }, { ...b, labels: ["B", "A"] }, { ...b, values: ["a", "changed"] },
      { ...b, values: undefined }, { ...b, poll: undefined },
      ...[{ seconds: 11 }, { multi: true }, { reveal: "live" as const }, { showVoters: true }, { question: "Other" }].map(p => ({ ...b, poll: { ...b.poll!, ...p } })),
    ];
    for (const changed of changes) expect(messageContentDigest("answer", "Answer", { buttonsDigest: buttonsDigest(changed) })).not.toBe(base);
    expect(buttonsDigest(undefined)).toBeUndefined();
    expect(messageContentDigest("answer", "Answer", { buttonsDigest: undefined })).toBe(messageContentDigest("answer", "Answer"));
    expect(messageContentDigest("answer", "changed", { buttonsDigest: buttonsDigest(b) })).not.toBe(base);
  });
});
