import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { applyHubMigrations } from "../src/hub/db.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
const path = "/hub/v1/me/prefs";

it("upgrades an existing hub.sqlite once, preserves person/session rows and persists on reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "agend-prefs-s149-")), file = join(dir, "hub.sqlite");
  let db = new Database(file);
  const older = HUB_HTTP_MIGRATIONS.filter(m => m.component !== "s3-person-prefs");
  try {
    applyHubMigrations(db, older);
    db.prepare("INSERT INTO hub_people VALUES('corp/alex','corp','alex','Alex','alex','active',1)").run();
    const before = db.prepare("SELECT * FROM hub_people").all();
    applyHubMigrations(db, HUB_HTTP_MIGRATIONS); applyHubMigrations(db, HUB_HTTP_MIGRATIONS);
    expect(db.prepare("SELECT * FROM hub_people").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM hub_person_prefs").all()).toEqual([]);
    db.prepare("INSERT INTO hub_person_prefs VALUES('corp/alex','[\"room-a\"]',1)").run();
    db.close(); db = new Database(file);
    expect(db.prepare("SELECT * FROM hub_person_prefs").get()).toEqual({ person: "corp/alex", favorites: '["room-a"]', revision: 1 });
    expect(() => applyHubMigrations(db, older)).toThrow(/s3-person-prefs/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("keeps preferences per immutable person across sessions, a login rename and HTTP remount", async () => {
  r = await s3bRig(); r.addPerson("alex"); r.addPerson("sam");
  const a = await r.signIn("alex"), b = await r.signIn("sam");
  expect((await r.call(null, "GET", path)).status).toBe(401);
  expect((await r.call(a, "GET", path)).json).toEqual({ favorites: [], initialized: false, revision: 0 });
  expect((await r.call(a, "PUT", path, { favorites: ["room-b", "room-a"] })).json).toEqual({ favorites: ["room-b", "room-a"], initialized: true, revision: 1 });
  expect((await r.call(b, "GET", path)).json.favorites).toEqual([]);
  await r.restartHttp(); r.rename("alex", "renamed");
  const secondDevice = await r.signIn("renamed");
  expect((await r.call(secondDevice, "GET", path)).json.favorites).toEqual(["room-b", "room-a"]);
  expect((await r.call(secondDevice, "GET", "/hub/v1/session")).json.features).toContain("person-prefs-v1");
  expect(r.http.features).toContain("person-prefs-v1");
});

it("requires own-session CSRF and same origin, and offers no person selector", async () => {
  r = await s3bRig(); r.addPerson("alex");
  const a = await r.signIn("admin"), b = await r.signIn("alex");
  const body = { favorites: ["a"] };
  expect((await r.call(a, "PUT", path, body, { "X-AgEnD-Hub-CSRF": "" })).status).toBe(403);
  expect((await r.call(a, "PUT", path, body, { "X-AgEnD-Hub-CSRF": b.csrf })).status).toBe(403);
  expect((await r.call(a, "PUT", path, body, { Origin: "https://other.test" })).status).toBe(403);
  expect((await r.call(a, "GET", path + "?person=alex")).status).toBe(400);
  expect((await r.call(a, "PUT", path, { ...body, person: "alex" })).status).toBe(400);
  expect((await r.call(a, "GET", path + "/alex")).status).toBe(404);
  expect((await r.call(a, "GET", path)).json.initialized).toBe(false);
  await r.call(a, "DELETE", "/hub/v1/session");
  expect((await r.call(a, "PUT", path, body)).status).toBe(401);
});

it("validates unique nonempty strings and the 50-item bound without changing the saved list", async () => {
  r = await s3bRig(); const a = await r.signIn("admin");
  expect((await r.call(a, "PUT", path, { favorites: Array.from({ length: 50 }, (_, i) => `r${i}`) })).status).toBe(200);
  const before = (await r.call(a, "GET", path)).json;
  const invalid = [null, "a", ["a", "a"], [""], [1], ["a\n"], ["x".repeat(129)], Array.from({ length: 51 }, (_, i) => `r${i}`)];
  for (const favorites of invalid) expect((await r.call(a, "PUT", path, { favorites })).status).toBe(400);
  expect((await r.call(a, "PUT", path, { favorites: [], onlyIfUnset: "yes" })).status).toBe(400);
  expect((await r.call(a, "GET", path)).json).toEqual(before);
});

it("carries a browser list over atomically only once, including a saved empty list", async () => {
  r = await s3bRig(); const a = await r.signIn("admin"), second = await r.signIn("admin");
  const answers = await Promise.all([
    r.call(a, "PUT", path, { favorites: ["one"], onlyIfUnset: true }),
    r.call(second, "PUT", path, { favorites: ["two"], onlyIfUnset: true }),
  ]);
  expect(answers.map(a => a.status)).toEqual([200, 200]);
  expect(answers[0]!.json).toEqual(answers[1]!.json);
  expect(answers[0]!.json.revision).toBe(1);
  await r.call(a, "PUT", path, { favorites: [] });
  expect((await r.call(second, "PUT", path, { favorites: ["old-browser"], onlyIfUnset: true })).json).toEqual({ favorites: [], initialized: true, revision: 2 });
});

it("refuses a disabled person's preference read/write", async () => {
  r = await s3bRig(); const a = await r.signIn("admin"); r.setEligible("admin", false);
  expect((await r.call(a, "GET", path)).status).toBe(401);
  expect((await r.call(a, "PUT", path, { favorites: ["a"] })).status).toBe(401);
  expect(r.db.prepare("SELECT * FROM hub_person_prefs").all()).toEqual([]);
});
