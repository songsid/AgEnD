import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { tForLocale } from "../src/locale.js";
import { captureRequestContextCall } from "../src/request-context-call.js";
import type { RequestContextTurnSnapshot } from "../src/request-context-turns.js";
function snapshot(): RequestContextTurnSnapshot {
  const id = randomUUID();
  return { token: randomUUID(), inputId: "admitted", wireSha256: "a".repeat(64),
    owner: { instance: "worker", incarnation: "incarnation", workGeneration: "work", daemonBootId: "boot", spawnGeneration: 1, launchFenceEpoch: 0, deliveryEpoch: 0 },
    context: { ref: { version: 1, contextId: id, rootContextId: id }, rootEvidenceRef: "fixture", ingress: "guest",
      initiatingActor: { kind: "person", platform: "discord", userId: "fixture-person" },
      source: { instance: "worker", incarnation: "incarnation" }, sourceAudience: { kind: "web", ref: randomUUID() } } };
}
it("captures immutable A, then refuses it after same-owner B replaces the active token", () => {
  const a = snapshot(), b = { ...snapshot(), owner: a.owner }; let active = a;
  const seen: RequestContextTurnSnapshot[] = [];
  const call = captureRequestContextCall(a, captured => { seen.push(captured); return captured.token === active.token; });
  expect(call.current()).toBe(true); expect(call.snapshot).toEqual(a); expect(call.snapshot).not.toBe(a);
  expect(Object.isFrozen(call.snapshot.context.initiatingActor)).toBe(true);
  active = b; expect(call.current()).toBe(false); expect(call.snapshot.context).toEqual(a.context);
  expect(seen.every(value => value === call.snapshot)).toBe(true);
});
it("validates owner and initial liveness, and a later failing owner lookup is unavailable", () => {
  const a = snapshot();
  expect(() => captureRequestContextCall({ ...a, owner: { ...a.owner, incarnation: "another" } }, () => true)).toThrow(/owner/);
  expect(() => captureRequestContextCall(a, () => false)).toThrow(/no longer current/);
  let fail = false; const call = captureRequestContextCall(a, () => { if (fail) throw Error("retired owner"); return true; });
  fail = true; expect(call.current()).toBe(false);
});

it("names the sending agent and a single-contact recovery in both dormant card reasons", () => {
  expect(tForLocale("en", "contact.interruptedLaunch", "Demo source")).toBe("Demo source was interrupted; this contact needs one approval.");
  expect(tForLocale("zh-TW", "contact.interruptedLaunch", "Demo source")).toBe("Demo source 曾中斷執行；這次聯絡需要核准一次。");
});
