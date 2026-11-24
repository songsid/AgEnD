/**
 * M-3600: a member's authorize refused "unavailable" with no cause on record (11-24, twice on one Fleet) and the question
 * waited a link round-trip. The Hub now logs which step could not answer (stage + code, no names or directory text) and
 * retries a transient step once; a real refusal is never retried. Actual Hub HTTP/SQLite with an inert member link.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubExposure, HubQuestion } from "../src/hub/types.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
let r: Rig | undefined;
afterEach(async () => { await r?.close(); r = undefined; vi.restoreAllMocks(); });

async function world() {
  r = await s3bRig();
  const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  (r.httpDeps as any).log = (level: string, message: string, meta?: Record<string, unknown>) => { logs.push({ level, message, meta }); };
  await r.restartHttp();
  const owner = r.addPerson("olivia", "Olivia"), asker = r.addPerson("alex", "Alex");
  const o = await r.signIn("olivia"), a = await r.signIn("alex");
  const fleetId = randomUUID(), link = r.link(fleetId, owner, 1, []);
  const e: HubExposure = { id: randomUUID(), fleetId, owner, displayName: "Desk", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [e] }, link) as never, link);
  const g = await r.call(o, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 1, login: "alex", days: 7 });
  const room = (await r.call(a, "POST", "/hub/v1/rooms", { exposureId: e.id, grantId: g.json.grant.id })).json.room.id;
  await r.http.receive(r.frame("reconcile", { afterReceiptSequence: 0, messages: [] }, link) as never, link);
  expect((await r.call(a, "POST", `/hub/v1/rooms/${room}/messages`, { idempotencyKey: randomUUID(), text: "Q?" })).status).toBe(200);
  await vi.waitFor(() => expect(r!.sent.some(s => s.frame.type === "question")).toBe(true));
  const messageId = (r.sent.find(s => s.frame.type === "question")!.frame.payload as HubQuestion).identity.messageId;
  const admit = async () => ((await r!.http.receive(r!.frame("authorize.request", { messageId, operationId: randomUUID(), exposureRevision: 1, phase: "admit" }, link) as never, link)) as any).payload;
  const original = r.directory.checkEligibility.bind(r.directory);
  /** The directory read for `who` throws `times` times (an LDAP timeout), then answers normally. */
  const failFor = (who: typeof asker, times: number) => {
    let left = times;
    vi.spyOn(r!.directory, "checkEligibility").mockImplementation(async key => {
      if (personKeyString(key) === personKeyString(who) && left > 0) { left--; throw new Error("ldap timeout"); }
      return original(key);
    });
  };
  const said = (message: string) => logs.filter(l => l.message === message).map(l => l.meta);
  return { owner, asker, admit, failFor, said, logs };
}

describe("M-3600 authorize refusals", () => {
  it("one directory read that cannot answer is retried once and the admit goes through, with the cause logged", async () => {
    const w = await world(); w.failFor(w.asker, 1);
    const out = await w.admit();
    expect(out.ok).toBe(true);
    expect(w.said("Hub authorize retrying after a transient refusal")).toEqual([expect.objectContaining({ phase: "admit", stage: "asker-directory", code: "Error", attempt: 1 })]);
    expect(w.said("Hub authorize refused")).toEqual([]);
  });
  it("still failing after the one retry: refused unavailable, and the log names the step that failed", async () => {
    const w = await world(); w.failFor(w.owner, 2);
    expect(await w.admit()).toEqual({ ok: false, reasonCode: "unavailable" });
    expect(w.said("Hub authorize refused")).toEqual([expect.objectContaining({ phase: "admit", stage: "owner-directory", code: "Error", attempt: 2 })]);
    expect(r!.audits.filter(x => x.action === "authorize.admit" && x.result === "denied").map(x => x.reasonCode)).toEqual(["unavailable"]);
  });
  it("a real refusal (the asker no longer eligible) is not retried and not logged as a failure", async () => {
    const w = await world();
    r!.setEligible("alex", false);
    const before = r!.directoryCalls;
    expect(await w.admit()).toEqual({ ok: false, reasonCode: "revoked" });
    expect(r!.directoryCalls - before).toBe(1);
    expect(w.said("Hub authorize retrying after a transient refusal")).toEqual([]);
    expect(w.said("Hub authorize refused")).toEqual([]);
  });
  it("the log carries no names, logins or directory text", async () => {
    const w = await world(); w.failFor(w.asker, 2);
    await w.admit();
    const text = JSON.stringify(w.logs);
    for (const s of ["alex", "Alex", "olivia", "ldap timeout", personKeyString(w.asker)]) expect(text).not.toContain(s);
  });
});
