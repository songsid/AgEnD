import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { OutboxOpenError } from "../src/outbox-open-error.js";
import { setLocale } from "../src/locale.js";

const fake = vi.hoisted(() => ({ openError: null as unknown }));
vi.mock("../src/delivery-outbox.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/delivery-outbox.js")>();
  return { ...actual, DeliveryOutbox: class extends actual.DeliveryOutbox {
    constructor(...args: ConstructorParameters<typeof actual.DeliveryOutbox>) {
      if (fake.openError) throw fake.openError;
      super(...args);
    }
  } };
});
const roots: string[] = [];
const stores: DeliveryOutbox[] = [];
const managers: FleetManager[] = [];
const coded = (code: string) => Object.assign(new Error(`fixture ${code}`), { code });
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agend-outbox-open-1490-")); roots.push(root);
  const fm = new FleetManager(root); managers.push(fm);
  // Real admission/open/startup methods, inert lifecycle and scheduling seams. No start of any fleet/adapter/backend.
  vi.spyOn(fm as any, "scheduleDeliveryOutboxPump").mockImplementation(() => {});
  vi.spyOn(fm as any, "createWakeCoordinator").mockReturnValue({ start: vi.fn(), stop: vi.fn(), kick: vi.fn() });
  const log = vi.spyOn((fm as any).logger, "error").mockImplementation(() => {});
  return { root, path: join(root, "delivery-outbox.db"), fm, log };
}
function open(fm: FleetManager) { (fm as any).ensureDeliveryOutbox(); if (fm.deliveryOutbox) stores.push(fm.deliveryOutbox); }
function caught(fn: () => unknown): OutboxOpenError {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(OutboxOpenError); return e as OutboxOpenError; }
  throw new Error("expected outbox refusal");
}
afterEach(() => {
  fake.openError = null; setLocale("en");
  for (const fm of managers.splice(0)) clearInterval((fm as any).replyObligationTimer);
  for (const store of stores.splice(0)) { try { store.close(); } catch {} }
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable outbox boot failures preserve evidence and explain recovery", () => {
  it("real corrupt SQLite refuses open and durable admission without moving or replacing any file", () => {
    const f = fixture(); writeFileSync(f.path, "not SQLite".repeat(50));
    const files = [f.path], before = files.map(hash);
    const failure = caught(() => open(f.fm));
    expect(failure.kind).toBe("corrupt"); expect(failure.dbPath).toBe(f.path);
    expect(failure.message).toContain("repair a copy"); expect(failure.message).toContain("Do not delete or reset");
    expect(f.fm.deliveryOutbox).toBeNull(); expect((f.fm as any).deliveryOutboxRecovered).toBe(false);
    expect(() => f.fm.admitDurableDelivery({ operationId: "refused", sourceInstance: "sender", sourceDaemonBootId: "boot", targetInstance: "worker", kind: "fleet_inbound", correlationId: "refused", payload: { content: "never admitted" } })).toThrow("Durable delivery store is unavailable");
    expect(files.map(hash)).toEqual(before); expect(readdirSync(f.root)).toEqual(["delivery-outbox.db"]);
    expect(f.log).toHaveBeenCalledWith(expect.objectContaining({ kind: "corrupt", dbPath: f.path }), failure.message);
  });
  it.each([["SQLITE_BUSY", "busy", "transaction finish"], ["ERR_DLOPEN_FAILED", "abi", "agend update --force"], ["EACCES", "other", "permissions"]])("%s gives its own recovery and preserves the native cause", (code, kind, hint) => {
    const f = fixture(); writeFileSync(f.path, "existing evidence");
    writeFileSync(`${f.path}-wal`, "journal evidence"); writeFileSync(`${f.path}-shm`, "shared memory evidence");
    const paths = [f.path, `${f.path}-wal`, `${f.path}-shm`], before = paths.map(hash);
    fake.openError = coded(code);
    const failure = caught(() => open(f.fm));
    expect(failure.kind).toBe(kind); expect(failure.cause).toBe(fake.openError); expect(failure.message).toContain(hint);
    expect(f.fm.deliveryOutbox).toBeNull(); expect(paths.map(hash)).toEqual(before); expect(readdirSync(f.root).sort()).toEqual(["delivery-outbox.db", "delivery-outbox.db-shm", "delivery-outbox.db-wal"]);
  });
  it("real unopenable directory is not reported as corruption", () => {
    const f = fixture(); mkdirSync(f.path); writeFileSync(join(f.path, "keep"), "evidence");
    expect(caught(() => open(f.fm)).kind).toBe("other");
    expect(readFileSync(join(f.path, "keep"), "utf8")).toBe("evidence");
  });
  it("recovery failure closes the unpublished owner; after repair a new owner recovers before admission", () => {
    const f = fixture(); const recover = vi.spyOn(DeliveryOutbox.prototype, "recoverForBoot").mockImplementationOnce(() => { throw coded("SQLITE_IOERR"); });
    const close = vi.spyOn(DeliveryOutbox.prototype, "close");
    expect(caught(() => open(f.fm)).kind).toBe("other");
    expect(close).toHaveBeenCalledOnce(); expect(f.fm.deliveryOutbox).toBeNull();
    expect((f.fm as any).deliveryOutboxRecovered).toBe(false);
    open(f.fm); expect(recover).toHaveBeenCalledTimes(2); expect(f.fm.deliveryOutbox).not.toBeNull();
    expect((f.fm as any).deliveryOutboxRecovered).toBe(true);
    (f.fm as any).daemons.set("sender", { bootId: "boot" });
    const row = f.fm.admitDurableDelivery({ operationId: "accepted", sourceInstance: "sender", sourceDaemonBootId: "boot", targetInstance: "worker", kind: "fleet_inbound", correlationId: "accepted", payload: { content: "accepted after repair" } });
    expect(row.state).toBe("queued");
  });
  it("startAll refuses before config loading or instance startup on an unavailable outbox", async () => {
    const f = fixture(); fake.openError = coded("ERR_DLOPEN_FAILED");
    vi.spyOn(f.fm as any, "loadEnvFile").mockImplementation(() => {});
    const config = vi.spyOn(f.fm as any, "loadConfig").mockImplementation(() => { throw new Error("startup must not reach config"); });
    const start = vi.spyOn(f.fm, "startInstance").mockImplementation(async () => { throw new Error("never start a backend"); });
    await expect(f.fm.startAll(join(f.root, "fleet.yaml"))).rejects.toMatchObject({ name: "OutboxOpenError", kind: "abi" });
    expect(config).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
  it("a failed native initialization closes its own connection and preserves the original error", () => {
    const f = fixture(); const error = coded("SQLITE_IOERR");
    const pragma = vi.spyOn(Database.prototype, "pragma").mockImplementationOnce(() => { throw error; });
    const close = vi.spyOn(Database.prototype, "close");
    expect(() => new DeliveryOutbox(f.path)).toThrow(error); expect(pragma).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
  it("a healthy existing queue survives a new boot and repeated ensure is idempotent", () => {
    const f = fixture(); const previous = new DeliveryOutbox(f.path, "before");
    const row = previous.admit({ operationId: "pending", sourceKey: "old:pending", sourceInstance: "sender", sourceDaemonBootId: "old", targetInstance: "worker", kind: "fleet_inbound", payload: { content: "retained" } }).delivery;
    previous.close(); open(f.fm); const owner = f.fm.deliveryOutbox; open(f.fm);
    expect(f.fm.deliveryOutbox).toBe(owner); expect(owner?.get(row.deliveryId)).toMatchObject({ state: "queued", payload: { content: "retained" } });
    expect(f.log).not.toHaveBeenCalled();
  });
  it("the diagnostic and recovery instructions exist in both locales", () => {
    setLocale("zh-TW"); const error = new OutboxOpenError("/fixture/outbox", coded("ERR_DLOPEN_FAILED"));
    expect(error.message).toContain("/fixture/outbox"); expect(error.message).toContain("agend update --force"); expect(error.message).toContain("請勿刪除或重設");
    expect(error.message).not.toContain("delivery.outbox_");
  });
});
