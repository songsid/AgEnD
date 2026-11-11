/** The same sealed writer gains a new operation; no host person or second config writer is invented. */
import Database from "better-sqlite3";
import { HUB_COMPANY_JOIN_MIGRATION } from "../src/hub/join/store.js";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import * as fs from "node:fs";
import { provisionHubIdentity } from "../src/hub/tls.js";
import { sealHubInitialization, verifyHubInitialization } from "../src/hub/initialization.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { createBrowserCertificate } from "../src/hub/init/browser-certificate.js";
import { createHubSettingsWriter } from "../src/hub/settings-commit.js";
import { HUB_WEB_ADDRESS_MIGRATION, createHubWebAddressDecision } from "../src/hub/settings-web-address-decision.js";
import type { HubWebAddressSettingsWriter } from "../src/hub/settings-web-address.js";
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});
const homes: string[] = [], dbs: Database.Database[] = [];
afterEach(() => {
    for (const d of dbs.splice(0))
        d.close();
    for (const h of homes.splice(0))
        rmSync(h, { recursive: true, force: true });
    vi.restoreAllMocks();
});
const owner = { kind: "host-owner" as const, sessionId: "host-launch-session", requestId: "request" };
async function rig() {
    const home = mkdtempSync(join(tmpdir(), "web-address-writer-"));
    homes.push(home);
    const identity = await provisionHubIdentity({ home, memberOrigin: "https://member.example.test:18443" });
    const material = await createBrowserCertificate(home, "https://new.example.test:19444");
    const cert = readFileSync(material.certFile, "utf8"), key = readFileSync(material.keyFile, "utf8");
    let hub: Record<string, unknown> = { enabled: true, hubId: identity.hubId, webOrigin: "https://old.example.test:18444", memberOrigin: "https://member.example.test:18443",
        webListen: { host: "127.0.0.1", port: 18444 }, memberListen: { host: "127.0.0.1", port: 18443 }, webTls: { certificateFile: material.certFile.slice(home.length + 1), keyFile: material.keyFile.slice(home.length + 1) },
        directory: { realm: "test", url: "ldaps://unused.example.test", profile: "ad", baseDn: "dc=test", bindDn: "cn=svc", bindPasswordRef: "agend-hub-secret:bind" }, administrator: { realm: "test", objectId: "00000000-0000-4000-8000-000000000001" }, retention: { contentDays: 30, eventDays: 90 }, coexistence: "dedicated" };
    const at = new Date().toISOString(), confirmationId = "a".repeat(32), planDigest = hubPlanDigest(hub);
    const manifest = { v: 1, hubId: identity.hubId, planDigest, committedAt: at, confirmationId, signature: sealHubInitialization({ home, planDigest, confirmationId, committedAt: at }) };
    writeFileSync(join(home, "hub/init-manifest.json"), JSON.stringify(manifest) + "\n", { mode: 0o600 });
    const db = new Database(":memory:");
    dbs.push(db);
    db.exec(`CREATE TABLE hub_browser_tls(singleton INTEGER PRIMARY KEY,hub_id TEXT,revision INTEGER,material_id TEXT,material_digest TEXT);CREATE TABLE hub_sessions(id TEXT,state TEXT);INSERT INTO hub_sessions VALUES('old','active')`);
    db.prepare("INSERT INTO hub_browser_tls VALUES(1,?,1,NULL,NULL)").run(identity.hubId);
    HUB_WEB_ADDRESS_MIGRATION.up(db);
    HUB_COMPANY_JOIN_MIGRATION.up(db);
    const decision = createHubWebAddressDecision({ db, home, hubId: identity.hubId, initial: hub.webTls as {
            certificateFile: string;
            keyFile: string;
        }, audit: { appendInTransaction: () => { } } });
    const writer = (step?: (s: string) => void) => createHubSettingsWriter({ home, readHub: () => structuredClone(hub), saveHub: patches => {
            for (const p of patches)
                hub[p.path[1]!] = p.value;
        }, webAddressDecision: () => decision, now: () => Date.now(), step } as Parameters<typeof createHubSettingsWriter>[0]);
    const op = (w: ReturnType<typeof writer>) => (w as typeof w & {
        webAddress: HubWebAddressSettingsWriter;
    }).webAddress;
    const candidate = { origin: "https://new.example.test:19444", listen: { host: "127.0.0.1", port: 19444 }, certificate: { cert, key } };
    const verify = () => verifyHubInitialization({ home, hubId: identity.hubId, memberOrigin: hub.memberOrigin as string, planDigest: hubPlanDigest(hub) });
    return { home, db, decision, writer, op, candidate, verify, hub: () => hub };
}
describe("#3428 shared sealed writer", () => {
    it.each(["owner", "epoch"])("controller refuses a replacement %s even when the host session id is reused", async mode => {
        const r = await rig(), writer = r.writer();
        const { createHubWebAddressControl } = await import("../src/hub/settings-web-address-control.js");
        const control = createHubWebAddressControl({ home: r.home, readConfig: () => ({ hub: r.hub() }), writer,
            withDecision: async (work, current) => { if (!current()) throw Error("retired"); return work(r.decision); },
            running: () => true, settle: async () => {}, probe: async () => {} });
        const ctx = { actor: owner, ownerKey: {}, authorityEpoch: 1, current: () => true };
        const p = await control.prepare({ origin: r.candidate.origin, listen: r.candidate.listen, certificate: { mode: "keep" } }, ctx);
        await expect(control.commit({ ref: p.ref }, { ...ctx, ...(mode === "owner" ? { ownerKey: {} } : { authorityEpoch: 2 }) })).rejects.toThrow("expired");
        expect(r.decision.head().revision).toBe(0); expect(r.verify()).toBeTruthy();
    });

    it("a retired preparation proof cannot be replaced by a fresh true callback", async () => {
        const r = await rig(), w = r.writer();
        let original = true;
        const p = r.op(w).prepare(r.candidate, owner, () => original);
        original = false;
        expect(() => r.op(w).commit(p.ref, owner, () => true)).toThrow("denied");
        expect(r.decision.head().revision).toBe(0);
    });
    it("expired references cannot write even though the owner remains signed in", async () => {
        const r = await rig(), w = r.writer(), p = r.op(w).prepare(r.candidate, owner, () => true);
        const now = Date.now();
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(now + 300001);
        try {
            expect(() => r.op(w).commit(p.ref, owner, () => true)).toThrow("expired");
            expect(r.decision.head().revision).toBe(0);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it("mount ties the web boundary to SQL while allowing a later legitimate rename", async () => {
        const r = await rig(), w = r.writer(), p = r.op(w).prepare(r.candidate, owner, () => true);
        r.op(w).commit(p.ref, owner, () => true);
        const admin = { person: r.hub().administrator as {
                realm: string;
                objectId: string;
            }, sessionId: "new-hub-session", requestId: "rename" };
        const rename = w.prepare({ kind: "rename", name: "Renamed after moving" }, admin);
        w.commit(rename.ref, admin, () => true);
        expect(() => r.decision.assertMounted(r.hub())).not.toThrow();
        expect(r.verify()).toBeTruthy();
        // Simulate an incomplete restore: new sealed files, old SQL. No filesystem mutation or reseal masks it.
        r.db.exec("DELETE FROM hub_web_address_operations;UPDATE hub_web_address_head SET revision=0,operation_id=NULL");
        expect(() => r.decision.assertMounted(r.hub())).toThrow("recovery");
        expect(r.verify()).toBeTruthy();
        expect(() => r.op(r.writer()).prepare(r.candidate, owner, () => true)).toThrow("recovery");
    });
    it("a directory durability failure refuses before the SQL decision, preserving the old sealed pair", async () => {
        const r = await rig(), w = r.writer(), before = structuredClone(r.hub()), p = r.op(w).prepare(r.candidate, owner, () => true), real = (await vi.importActual<typeof import("node:fs")>("node:fs")).fsyncSync;
        const spy = vi.mocked(fs.fsyncSync).mockImplementation(fd => { if (fs.fstatSync(fd).isDirectory())
            throw Error("directory durability unavailable"); real(fd); });
        try {
            expect(() => r.op(w).commit(p.ref, owner, () => true)).toThrow("directory durability unavailable");
        }
        finally {
            spy.mockImplementation(real);
        }
        expect(r.hub()).toEqual(before);
        expect(r.decision.head().revision).toBe(0);
        expect(r.verify()).toBeTruthy();
    });
    it("reseals only web address/TLS and ends old sessions without changing member or issuer identity", async () => {
        const r = await rig(), w = r.writer(), before = structuredClone(r.hub()), identity = readFileSync(join(r.home, "hub/keys/identity.json"));
        const p = r.op(w).prepare(r.candidate, owner, () => true);
        expect(r.hub()).toEqual(before);
        r.op(w).commit(p.ref, owner, () => true);
        expect(r.verify()).toBeTruthy();
        expect(() => r.decision.assertMounted(r.hub())).not.toThrow();
        expect(r.hub()).toMatchObject({ webOrigin: r.candidate.origin, webListen: r.candidate.listen, memberOrigin: before.memberOrigin, memberListen: before.memberListen, directory: before.directory, administrator: before.administrator });
        expect(readFileSync(join(r.home, "hub/keys/identity.json"))).toEqual(identity);
        expect(w.pending()).toBe(false);
        expect(r.db.prepare("SELECT state FROM hub_sessions").get()).toEqual({ state: "ended" });
    });
    for (const at of ["web-certificate", "web-key", "web-material", "web-staged", "web-decision", "web-manifest", "web-config", "web-receipt", "web-done", "web-cleanup-journal", "web-cleanup-stage"]) {
        it(`crash after ${at}: exact recovery follows SQL once`, async () => {
            const r = await rig(), before = structuredClone(r.hub()), w = r.writer(s => {
                if (s === at)
                    throw Error("crash");
            });
            const p = r.op(w).prepare(r.candidate, owner, () => true);
            expect(() => r.op(w).commit(p.ref, owner, () => true)).toThrow("crash");
            const beforeJournal = ["web-certificate", "web-key", "web-material"].includes(at);
            expect(w.pending()).toBe(!beforeJournal && !at.startsWith("web-cleanup-"));
            r.writer().recover();
            expect(r.verify()).toBeTruthy();
            expect(r.hub().webOrigin).toBe(beforeJournal || at === "web-staged" ? before.webOrigin : r.candidate.origin);
            expect(w.pending()).toBe(false);
            r.db.prepare("INSERT INTO hub_sessions VALUES('new','active')").run();
            r.writer().recover();
            expect(r.db.prepare("SELECT state FROM hub_sessions WHERE id='new'").get()).toEqual({ state: "active" });
        });
    }
    it("a revoked owner after staging cannot decide and recovery leaves the old pair intact", async () => {
        const r = await rig(), before = structuredClone(r.hub());
        let current = true;
        const w = r.writer(s => {
            if (s === "web-staged")
                current = false;
        });
        const p = r.op(w).prepare(r.candidate, owner, () => current);
        expect(() => r.op(w).commit(p.ref, owner, () => current)).toThrow();
        r.writer().recover();
        expect(r.hub()).toEqual(before);
        expect(r.decision.head().revision).toBe(0);
        expect(existsSync(join(r.home, "hub/settings-journal.json"))).toBe(false);
    });
    it("rejects a certificate for another hostname before any durable write", async () => {
        const r = await rig(), w = r.writer(), before = structuredClone(r.hub());
        expect(() => r.op(w).prepare({ ...r.candidate, origin: "https://wrong.example.test:19444" }, owner, () => true)).toThrow("certificate");
        expect(r.hub()).toEqual(before);
        expect(w.pending()).toBe(false);
        expect(r.decision.head().revision).toBe(0);
    });
    it("another session or a changed TLS selection cannot redeem a prepared operation; refs are single-use", async () => {
        const r = await rig(), w = r.writer(), p = r.op(w).prepare(r.candidate, owner, () => true);
        expect(() => r.op(w).commit(p.ref, { ...owner, sessionId: "another-session" }, () => true)).toThrow();
        expect(() => r.op(w).commit(p.ref, owner, () => true)).toThrow("expired");
        const next = r.op(w).prepare(r.candidate, owner, () => true);
        r.db.prepare("UPDATE hub_browser_tls SET revision=2").run();
        expect(() => r.op(w).commit(next.ref, owner, () => true)).toThrow("stale");
        expect(w.pending()).toBe(false);
    });
    it("recovery preserves an unrelated config edit instead of overwriting it", async () => {
        const r = await rig(), w = r.writer(s => {
            if (s === "web-decision")
                throw Error("crash");
        }), p = r.op(w).prepare(r.candidate, owner, () => true);
        expect(() => r.op(w).commit(p.ref, owner, () => true)).toThrow("crash");
        const manifest = readFileSync(join(r.home, "hub/init-manifest.json"));
        r.hub().name = "outside edit";
        expect(() => r.writer().recover()).toThrow("recovery");
        expect(r.hub().name).toBe("outside edit");
        expect(readFileSync(join(r.home, "hub/init-manifest.json"))).toEqual(manifest);
        expect(w.pending()).toBe(true);
    });
    it("a changed staged certificate after SQL is refused before manifest/config installation", async () => {
        const r = await rig(), before = structuredClone(r.hub()), manifest = readFileSync(join(r.home, "hub/init-manifest.json"));
        const w = r.writer(s => {
            if (s === "web-decision") {
                const j = JSON.parse(readFileSync(join(r.home, "hub/settings-journal.json"), "utf8"));
                writeFileSync(join(r.home, `hub/web-address/${j.id}/cert.pem`), "outside replacement", { mode: 0o600 });
            }
        }), p = r.op(w).prepare(r.candidate, owner, () => true);
        expect(() => r.op(w).commit(p.ref, owner, () => true)).toThrow("recovery");
        expect(r.hub()).toEqual(before);
        expect(readFileSync(join(r.home, "hub/init-manifest.json"))).toEqual(manifest);
        expect(() => r.writer().recover()).toThrow("recovery");
    });
});
