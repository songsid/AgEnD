import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; vi.useRealTimers(); });
async function world(lookup: (v: string) => Promise<"found" | "not-found" | "unavailable"> = async () => "found") {
  r = await s3bRig({ versionRegistry: lookup });
  r.httpDeps.hubSettings = { info: { hubId: r.hubId, memberSpkiSha256: "a".repeat(64), issuerKeyId: "b".repeat(64), version: "2.4.0-beta.4" } };
  const admin = await r.signIn("admin"), owner = r.addPerson("owner");
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => {
    for (let i = 0; i < ids.length; i++) state.fleets.push({ id: ids[i]!, owner, generation: 1, credentialHash: "a".repeat(64), status: i === 2 ? "revoked" : "active" });
  });
  const link = r.link(ids[0]!, owner, 1, ["welcome-caps-v1", "room-ask-v1", "fleet-info-v1", "fleet-recommend-v1"]);
  await r.http.receive(r.frame("fleet.info", { version: "2.3.5", runsAsService: true }, link) as never, link);
  return { admin, owner, ids, link };
}
const path = "/hub/v1/admin/recommended-version";
it("starts unconfigured, previews without saving, and saves the Hub-following recommendation explicitly", async () => {
  const w = await world();
  expect((await r!.call(w.admin, "GET", path)).json).toMatchObject({ mode: "none", configured: false, version: null, recommendedVersion: null, revision: 0, setAt: null });
  expect((await r!.call(w.admin, "POST", path + "/preview", { mode: "hub" })).json).toEqual({ recommendedVersion: "2.4.0-beta.4", affected: 2, revision: 0 });
  expect((await r!.call(w.admin, "GET", path)).json.configured).toBe(false);
  const saved = await r!.call(w.admin, "PUT", path, { mode: "hub", ifRevision: 0 });
  expect(saved.status).toBe(200);
  expect(saved.json).toMatchObject({ mode: "hub", configured: true, version: null, recommendedVersion: "2.4.0-beta.4", revision: 1 });
  const overview = (await r!.call(w.admin, "GET", "/hub/v1/admin/overview")).json;
  expect(overview.recommendedVersion).toBe("2.4.0-beta.4");
  expect(overview.fleets.find((f: any) => f.id === w.ids[0])).toMatchObject({ versionState: "needs-update", recommendationNotifiedAt: null });
  expect((await r!.call(await r!.signIn("owner"), "GET", "/hub/v1/me/fleets")).json.fleets[0].versionState).toBe("needs-update");
});
it("checks an exact version on npm and distinguishes invalid, missing, outage and revision refusals", async () => {
  const checked: string[] = [];
  const w = await world(async v => { checked.push(v); return v === "2.4.0" ? "not-found" : v === "2.5.0" ? "unavailable" : "found"; });
  expect((await r!.call(w.admin, "POST", path + "/preview", { mode: "specific", version: "--registry bad" })).json).toEqual({ code: "version-invalid" });
  expect(checked).toHaveLength(0);
  const missing = await r!.call(w.admin, "PUT", path, { mode: "specific", version: "2.4.0", ifRevision: 0 });
  expect(missing.status).toBe(422); expect(missing.json).toEqual({ code: "version-not-found", version: "2.4.0" });
  expect((await r!.call(w.admin, "POST", path + "/preview", { mode: "specific", version: "2.5.0" })).json).toEqual({ code: "npm-unavailable", version: "2.5.0" });
  expect((await r!.call(w.admin, "PUT", path, { mode: "none", ifRevision: 0 })).status).toBe(200);
  expect((await r!.call(w.admin, "PUT", path, { mode: "hub", ifRevision: 0 })).json).toEqual({ code: "revision-conflict" });
  expect((await r!.call(await r!.signIn("owner"), "GET", path)).status).toBe(403);
  expect((await r!.call(w.admin, "PUT", path, { mode: "none", ifRevision: 1 }, { "X-AgEnD-Hub-CSRF": "wrong" })).status).toBe(403);
});
it("re-fences a held npm lookup against a signed-out administrator and a competing save", async () => {
  let finish!: (v: "found") => void;
  const lookup = vi.fn(async () => new Promise<"found">(resolve => { finish = resolve; }));
  const w = await world(lookup);
  const held = r!.call(w.admin, "PUT", path, { mode: "specific", version: "2.4.0", ifRevision: 0 });
  await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
  expect((await r!.call(w.admin, "PUT", path, { mode: "none", ifRevision: 0 })).status).toBe(200);
  finish("found"); expect((await held).json).toEqual({ code: "revision-conflict" });
  const next = r!.call(w.admin, "PUT", path, { mode: "specific", version: "2.4.0", ifRevision: 1 });
  await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
  await r!.call(w.admin, "DELETE", "/hub/v1/session");
  finish("found"); expect((await next).status).toBe(403);
  expect(r!.db.prepare("SELECT mode,revision FROM hub_version_recommendation").get()).toEqual({ mode: "none", revision: 1 });
});
it("sends only to opted-in ready links, records matching ACK time, and withdraws with a newer null policy", async () => {
  const w = await world();
  const saved = (await r!.call(w.admin, "PUT", path, { mode: "hub", ifRevision: 0 })).json;
  expect(r!.sent.filter(s => s.frame.type === "fleet.recommendation")).toHaveLength(0);
  r!.http.memberReady!(w.link);
  await vi.waitFor(() => expect(r!.sent.filter(s => s.frame.type === "fleet.recommendation")).toHaveLength(1));
  const message = r!.sent.find(s => s.frame.type === "fleet.recommendation")!.frame;
  expect(message.payload).toEqual({ version: saved.recommendedVersion, revision: saved.revision, setAt: saved.setAt });
  await r!.http.receive(r!.frame("fleet.recommendation-ack", { version: saved.recommendedVersion, revision: 99, status: "offered" }, w.link) as never, w.link);
  expect((await r!.call(w.admin, "GET", "/hub/v1/admin/overview")).json.fleets[0].recommendationNotifiedAt).toBeNull();
  await r!.http.receive(r!.frame("fleet.recommendation-ack", { version: saved.recommendedVersion, revision: saved.revision, status: "offered" }, w.link) as never, w.link);
  expect((await r!.call(w.admin, "GET", "/hub/v1/admin/overview")).json.fleets[0].recommendationNotifiedAt).toEqual(expect.any(Number));
  await r!.call(w.admin, "PUT", path, { mode: "none", ifRevision: 1 });
  await vi.waitFor(() => expect(r!.sent.filter(s => s.frame.type === "fleet.recommendation").at(-1)?.frame.payload).toMatchObject({ revision: 2, version: null }));
  expect((await r!.call(w.admin, "GET", "/hub/v1/admin/overview")).json.fleets[0].recommendationNotifiedAt).toBeNull();
});
it("follows a restarted Hub, retains settings, retries only live unacknowledged links, and reoffers after reconnect", async () => {
  const w = await world();
  await r!.call(w.admin, "PUT", path, { mode: "hub", ifRevision: 0 });
  await r!.restartHttp();
  expect((await r!.call(w.admin, "GET", path)).json).toMatchObject({ configured: true, mode: "hub", revision: 1 });
  r!.httpDeps.hubSettings = { ...r!.httpDeps.hubSettings!, info: { ...r!.httpDeps.hubSettings!.info, version: "2.4.0-beta.5" } };
  const updated = (await r!.call(w.admin, "GET", path)).json;
  expect(updated).toMatchObject({ recommendedVersion: "2.4.0-beta.5", revision: 2 });
  expect((await r!.call(w.admin, "GET", path)).json.revision).toBe(2);
  r!.http.memberReady!(w.link); await vi.waitFor(() => expect(r!.sent.filter(s => s.frame.type === "fleet.recommendation")).toHaveLength(1));
  vi.useFakeTimers();
  // A fresh live-link ready call is sufficient to retry a due send; no polling of offline fleets.
  vi.setSystemTime(Date.now() + 31_000); r!.http.memberReady!(w.link); await Promise.resolve();
  expect(r!.sent.filter(s => s.frame.type === "fleet.recommendation")).toHaveLength(2);
  await r!.http.receive(r!.frame("fleet.recommendation-ack", { version: updated.recommendedVersion, revision: 2, status: "current" }, w.link) as never, w.link);
  vi.setSystemTime(Date.now() + 31_000); r!.http.memberReady!(w.link); await Promise.resolve();
  expect(r!.sent.filter(s => s.frame.type === "fleet.recommendation")).toHaveLength(2);
  w.link.alive = false;
  const next = r!.link(w.ids[0]!, w.owner, 2, [...w.link.features]); r!.http.memberReady!(next); await Promise.resolve();
  expect(r!.sent.filter(s => s.frame.type === "fleet.recommendation")).toHaveLength(3);
  expect(r!.sent.filter(s => s.frame.type === "fleet.recommendation").at(-1)?.frame.linkEpoch).toBe(2);
});
it("reads the recommendation once for an entire 200-Fleet overview", async () => {
  const w = await world();
  r!.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => {
    while (state.fleets.length < 200) state.fleets.push({ id: randomUUID(), owner: w.owner, generation: 1, credentialHash: "a".repeat(64), status: "active" });
  });
  const prepare = vi.spyOn(r!.db, "prepare");
  try {
    const response = await r!.call(w.admin, "GET", "/hub/v1/admin/overview");
    expect(response.status).toBe(200); expect(response.json.fleets).toHaveLength(200);
    expect(prepare.mock.calls.filter(([sql]) => sql === "SELECT * FROM hub_version_recommendation WHERE singleton=1")).toHaveLength(1);
  } finally { prepare.mockRestore(); }
});
