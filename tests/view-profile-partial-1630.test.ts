/**
 * #1630 follow-up (the leader, on Fable's #1644 note): View's profile POST changes only the fields the request carries —
 * one left out stays as it is; a blank one clears it (#1644); anything but a string or null is refused. The real
 * handleViewRequest on a scratch profiles.db.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { handleViewRequest } from "../src/view-api.js";

const TOKEN = "t".repeat(48);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world() {
  const dir = mkdtempSync(join(tmpdir(), "agend-profile-")); dirs.push(dir);
  const fleetConfig = { defaults: {}, instances: { "web-dev": { working_directory: dir } } };
  const post = (body: unknown) => new Promise<{ status: number; body: any }>(resolve => {
    let status = 0;
    const req = Object.assign(new EventEmitter(), { method: "POST", headers: { "x-agend-token": TOKEN, "content-type": "application/json" }, url: "/api/profile/web-dev" });
    const res = { writeHead(code: number) { status = code; return res; }, setHeader() {}, end(b?: string) { resolve({ status, body: b ? JSON.parse(b) : null }); } } as unknown as ServerResponse;
    handleViewRequest(req as unknown as IncomingMessage, res, new URL("http://localhost/api/profile/web-dev"), {
      webToken: TOKEN, dataDir: dir, fleetConfig, classicChannels: null,
      logger: { debug() {}, info() {}, warn() {}, error() {} }, getInstanceStatus: () => "running",
      getUiStatus: () => ({ instances: [] }), resolveInstanceModel: () => ({ model: "" }),
    } as never);
    queueMicrotask(() => { req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body))); req.emit("end"); });
  });
  const exists = () => existsSync(join(dir, "profiles.db"));
  const row = () => {
    if (!exists()) return undefined;
    const db = new Database(join(dir, "profiles.db"));
    try { return db.prepare("SELECT display_name, role, description, avatar_path FROM instance_profile WHERE instance_name = 'web-dev'").get() as Record<string, unknown> | undefined; }
    finally { db.close(); }
  };
  const setAvatar = (file: string) => { const db = new Database(join(dir, "profiles.db")); db.prepare("UPDATE instance_profile SET avatar_path = ? WHERE instance_name = 'web-dev'").run(file); db.close(); };
  return { post, row, setAvatar, exists };
}

describe("the profile POST changes only what it carries", () => {
  it("a partial body leaves the other fields as they were (and the avatar always)", async () => {
    const w = world();
    expect((await w.post({ display_name: "Sentinel", role: "builder", description: "Writes the notes" })).status).toBe(200);
    w.setAvatar("web-dev.png");
    expect((await w.post({ role: "reviewer" })).status).toBe(200);
    expect(w.row()).toEqual({ display_name: "Sentinel", role: "reviewer", description: "Writes the notes", avatar_path: "web-dev.png" });
    expect((await w.post({ description: "Reviews PRs" })).status).toBe(200);
    expect(w.row()).toEqual({ display_name: "Sentinel", role: "reviewer", description: "Reviews PRs", avatar_path: "web-dev.png" });
  });
  it("a field sent blank clears it (stored as none); the others stay", async () => {
    const w = world();
    await w.post({ display_name: "Sentinel", role: "builder", description: "d" });
    expect((await w.post({ display_name: "", role: "   " })).status).toBe(200);
    expect(w.row()).toEqual({ display_name: null, role: null, description: "d", avatar_path: null });
    expect((await w.post({ description: null })).status).toBe(200);
    expect(w.row()!.description).toBeNull();
  });
  it("a first partial write creates the row with just that field", async () => {
    const w = world();
    expect((await w.post({ role: "builder" })).status).toBe(200);
    expect(w.row()).toEqual({ display_name: null, role: "builder", description: null, avatar_path: null });
  });
  it("nothing to change: no row, no write", async () => {
    const w = world();
    expect((await w.post({})).status).toBe(200);
    expect((await w.post({ unrelated: "x" })).status).toBe(200);
    expect(w.exists(), "the profile store is not even created").toBe(false);
  });
  it("a field that is not a string (or null), or a body that is not an object, is refused and nothing is written", async () => {
    const w = world();
    await w.post({ display_name: "Sentinel" });
    for (const body of [{ display_name: 5 }, { role: { a: 1 } }, { description: ["x"] }, [], "not json"]) {
      expect((await w.post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(w.row()).toEqual({ display_name: "Sentinel", role: null, description: null, avatar_path: null });
  });
});
