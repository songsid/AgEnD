/** Real private files + SQLite only; no service or external host. */
import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { HubFileVersionFloor } from "../src/hub/version-floor.js";
import { HubTransportStore, migrateHubTransportStore } from "../src/hub/store.js";
const syncFault = vi.hoisted(() => ({ directories: false }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, fsyncSync(fd: number) { if (syncFault.directories && fs.fstatSync(fd).isDirectory()) throw Error("Directory flush rejected"); fs.fsyncSync(fd); } };
});
const roots: string[] = [], dbs: Database.Database[] = [];
afterEach(() => { syncFault.directories = false; dbs.splice(0).forEach(db => db.close()); roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function home() { mkdirSync(".artifacts", { recursive: true }); const p = mkdtempSync(join(process.cwd(), ".artifacts/hub-floor-")); chmodSync(p, 0o700); roots.push(p); return p; }
it("initializes explicitly, survives reopening and refuses missing, backward or reset revisions", () => {
  const root = home(), floor = new HubFileVersionFloor(root, "hub/floors/transport");
  expect(() => floor.read()).toThrow(); expect(existsSync(join(root, "hub"))).toBe(false);
  floor.initialize(); expect(floor.read()).toBe(0); floor.raise(4);
  expect(new HubFileVersionFloor(root, "hub/floors/transport").read()).toBe(4);
  expect(() => floor.raise(3)).toThrow(); expect(() => floor.initialize()).toThrow(); expect(floor.read()).toBe(4);
});
it("rejects a malformed primitive, unsafe permissions or a symlink rather than repairing it", () => {
  const root = home(), floor = new HubFileVersionFloor(root, "hub/floors/transport"), path = join(root, "hub/floors/transport"); floor.initialize();
  for (const body of ["[1]", "{}", "null", "-1", "1.5", "9007199254740992"]) { writeFileSync(path, body); expect(() => floor.read()).toThrow(); }
  writeFileSync(path, "1"); chmodSync(path, 0o644); expect(() => floor.read()).toThrow(); chmodSync(path, 0o600);
  rmSync(path); symlinkSync(join(root, "target-never-created"), path); expect(() => floor.read()).toThrow(); expect(existsSync(join(root, "target-never-created"))).toBe(false);
});
it("keeps a failed audited publication frozen after a store restart and refuses a rolled-back SQLite state", () => {
  const root = home(), floor = new HubFileVersionFloor(root, "hub/floors/transport"); floor.initialize();
  const db = new Database(join(root, "state.sqlite")); dbs.push(db); chmodSync(join(root, "state.sqlite"), 0o600); migrateHubTransportStore(db);
  const store = new HubTransportStore(db, { floor, appendAudit: () => { throw Error("inert audit failure"); } }); store.initialize();
  const event = { at: Date.now(), requestId: randomUUID(), actor: { kind: "local-host" as const }, action: "fixture", result: "allowed" as const };
  expect(() => store.mutate(event, state => { state.revocationVersion++; })).toThrow("inert audit failure");
  expect(floor.read()).toBe(1);
  const reopened = new HubTransportStore(db, { floor: new HubFileVersionFloor(root, "hub/floors/transport"), appendAudit: () => {} });
  expect(() => reopened.read()).toThrow(); expect(() => reopened.initialize()).toThrow(); expect(floor.read()).toBe(1);
});
it("requires an audit write to finish synchronously in the same transaction", () => {
  const root = home(), floor = new HubFileVersionFloor(root, "hub/floors/transport"); floor.initialize();
  const db = new Database(":memory:"); dbs.push(db); migrateHubTransportStore(db);
  const store = new HubTransportStore(db, { floor, appendAudit: async () => {} }); store.initialize();
  expect(() => store.mutate({ at: Date.now(), requestId: randomUUID(), actor: { kind: "local-host" }, action: "fixture", result: "allowed" }, () => {})).toThrow();
  expect(floor.read()).toBe(1); expect(() => new HubTransportStore(db, { floor, appendAudit: () => {} }).read()).toThrow();
});

it("requires the renamed floor's directory entry to be flushed before publication can continue", () => {
  const root = home(), floor = new HubFileVersionFloor(root, "hub/floors/transport"); floor.initialize();
  syncFault.directories = true;
  expect(() => floor.raise(1)).toThrow("Directory flush rejected");
});
