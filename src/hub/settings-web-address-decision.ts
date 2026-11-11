/** #3428 SQL participant of the sealed-settings writer. It never writes files or authorizes an HTTP caller. */
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { HubMigration } from "./db.js";
import type { HubAuditStore } from "./audit/index.js";
import { readPrivateFile } from "./private-files.js";
import { canonicalArguments } from "./identity.js";
import { HubWebAddressError, hubWebAddressBoundary } from "./settings-web-address-policy.js";
import { retireCompanyJoinForWebAddress } from "./join/store.js";
import { HubProtocolError } from "./validation.js";
const hash = z.string().regex(/^[0-9a-f]{64}$/), id = z.string().uuid(), revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const actor = z.strictObject({ kind: z.literal("host-owner"), sessionId: z.string().min(1).max(256), requestId: z.string().min(1).max(256) });
export type HubWebAddressActor = z.infer<typeof actor>;
const selector = z.strictObject({ revision: revision.refine(n => n > 0), materialId: id.nullable(), materialDigest: hash.nullable() })
    .refine(s => (s.materialId === null) === (s.materialDigest === null));
const expected = z.strictObject({ revision, operationId: id.nullable(), selector, materialSha: hash });
const image = z.strictObject({ configSha: hash, manifestSha: hash });
const operation = z.strictObject({ v: z.literal(1), kind: z.literal("web-address"), id, expected, revision,
    before: image, after: image.extend({ certificateSha: hash, keySha: hash, webSha: hash }), receiptSha: hash, actor, at: revision });
export type HubWebAddressOperation = z.infer<typeof operation>;
export type HubWebAddressExpectation = z.infer<typeof expected>;
export const hubWebAddressSha = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown) => canonicalArguments(a) === canonicalArguments(b);
const refuse = (): never => { throw new HubWebAddressError("recovery"); };
export const HUB_WEB_ADDRESS_MIGRATION: HubMigration = Object.freeze({ component: "s5-web-address", version: 1, up(db: Database.Database) {
        const present = ["hub_web_address_head", "hub_web_address_operations"].map(name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
        if (present.some(Boolean) && !present.every(Boolean))
            refuse();
        if (!present[0])
            db.exec(`CREATE TABLE hub_web_address_head(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>=0),operation_id TEXT);
    INSERT INTO hub_web_address_head VALUES(1,0,NULL);
    CREATE TABLE hub_web_address_operations(id TEXT PRIMARY KEY,body TEXT NOT NULL);`);
        readHubWebAddressHead(db);
    } });
function readOperation(db: Database.Database, opId: string): HubWebAddressOperation {
    try {
        const row = db.prepare("SELECT body FROM hub_web_address_operations WHERE id=?").get(opId) as {
            body: string;
        } | undefined;
        if (!row)
            return refuse();
        const parsed = operation.parse(JSON.parse(row.body));
        if (parsed.id !== opId || parsed.revision !== parsed.expected.revision + 1)
            return refuse();
        return parsed;
    }
    catch {
        return refuse();
    }
}
export function readHubWebAddressHead(db: Database.Database): {
    revision: number;
    operationId: string | null;
} {
    try {
        const row = db.prepare("SELECT revision,operation_id FROM hub_web_address_head WHERE singleton=1").get() as {
            revision: number;
            operation_id: string | null;
        } | undefined;
        if (!row || !revision.safeParse(row.revision).success || (row.revision === 0 ? row.operation_id !== null : !id.safeParse(row.operation_id).success))
            return refuse();
        if (row.operation_id !== null && readOperation(db, row.operation_id).revision !== row.revision)
            return refuse();
        return { revision: row.revision, operationId: row.operation_id };
    }
    catch {
        return refuse();
    }
}
export function createHubWebAddressDecision(options: {
    db: Database.Database;
    home: string;
    hubId: string;
    initial: {
        certificateFile: string;
        keyFile: string;
    };
    audit: Pick<HubAuditStore, "appendInTransaction">;
    now?(): number;
}) {
    const { db, home, hubId } = options, initial = { ...options.initial };
    const tls = () => {
        const row = db.prepare("SELECT hub_id,revision,material_id,material_digest FROM hub_browser_tls WHERE singleton=1").get() as {
            hub_id: string;
            revision: number;
            material_id: string | null;
            material_digest: string | null;
        } | undefined;
        if (!row || row.hub_id !== hubId)
            return refuse();
        const result = selector.safeParse({ revision: row.revision, materialId: row.material_id, materialDigest: row.material_digest });
        if (!result.success)
            return refuse();
        return result.data;
    };
    const material = () => {
        const s = tls();
        const text = s.materialId === null
            ? JSON.stringify({ cert: readPrivateFile(home, initial.certificateFile), key: readPrivateFile(home, initial.keyFile) })
            : readPrivateFile(home, `hub/web-tls/versions/${s.materialId}/material.json`, 128 * 1024);
        if (s.materialDigest !== null && hubWebAddressSha(text) !== s.materialDigest)
            return refuse();
        const p = z.strictObject({ cert: z.string().min(1), key: z.string().min(1) }).safeParse(JSON.parse(text));
        if (!p.success)
            return refuse();
        return { selector: s, material: p.data, materialSha: hubWebAddressSha(text) };
    };
    const inspect = (): HubWebAddressExpectation => {
        const head = readHubWebAddressHead(db), m = material();
        return { ...head, selector: m.selector, materialSha: m.materialSha };
    };
    const assertExpected = (value: HubWebAddressExpectation) => {
        if (!same(inspect(), value))
            throw new HubWebAddressError("stale");
    };
    return {
        hubId, inspect,
        material: () => structuredClone(material().material),
        head: () => readHubWebAddressHead(db),
        assertMounted(raw: unknown): void {
            const hub = raw as Record<string, unknown>, head = readHubWebAddressHead(db);
            if (head.operationId === null) {
                if (hub.webAddress !== undefined)
                    throw new HubWebAddressError("recovery");
                return;
            }
            const op = readOperation(db, head.operationId), tls = hub.webTls as {
                certificateFile: string;
                keyFile: string;
            };
            if (!same(hub.webAddress, { operationId: op.id, revision: op.revision }) || hubWebAddressSha(canonicalArguments(hubWebAddressBoundary(hub))) !== op.after.webSha
                || hubWebAddressSha(readPrivateFile(home, tls.certificateFile, 65536)) !== op.after.certificateSha
                || hubWebAddressSha(readPrivateFile(home, tls.keyFile, 16384)) !== op.after.keySha)
                throw new HubWebAddressError("recovery");
        },
        assertOperation(opId: string): void {
            const op = readOperation(db, opId), head = readHubWebAddressHead(db), selected = tls();
            if (head.operationId !== op.id || head.revision !== op.revision || selected.revision !== op.expected.selector.revision + 1
                || selected.materialId !== null || selected.materialDigest !== null)
                throw new HubWebAddressError("recovery");
        },
        lookup(opId: string): HubWebAddressOperation | null {
            if (!id.safeParse(opId).success)
                return refuse();
            readHubWebAddressHead(db);
            return db.prepare("SELECT 1 FROM hub_web_address_operations WHERE id=?").get(opId) ? readOperation(db, opId) : null;
        },
        commit(raw: HubWebAddressOperation, current: () => boolean): HubWebAddressOperation {
            const input = operation.parse(raw);
            if (input.revision !== input.expected.revision + 1 || input.expected.selector.revision === Number.MAX_SAFE_INTEGER || db.inTransaction)
                throw new HubWebAddressError("invalid");
            const proof = () => {
                const v: unknown = current();
                if (v !== true) {
                    if (v && typeof (v as PromiseLike<unknown>).then === "function")
                        void Promise.resolve(v).catch(() => { });
                    throw new HubWebAddressError("denied");
                }
            };
            return db.transaction(() => {
                proof();
                assertExpected(input.expected);
                const result: unknown = options.audit.appendInTransaction({ id: input.id, sequence: input.revision, at: input.at,
                    requestId: input.actor.requestId, actor: { kind: "local-host" }, action: "hub.web-address.changed", result: "completed", policyVersion: input.revision }, db);
                if (result && typeof (result as PromiseLike<unknown>).then === "function") {
                    void Promise.resolve(result).catch(() => { });
                    throw new HubWebAddressError("unavailable");
                }
                proof();
                assertExpected(input.expected);
                try {
                    retireCompanyJoinForWebAddress(db, options.now?.() ?? Date.now());
                }
                catch (error) {
                    if (error instanceof HubProtocolError && error.code === "backpressure")
                        throw new HubWebAddressError("busy");
                    throw error;
                }
                const changed = db.prepare("UPDATE hub_browser_tls SET revision=?,material_id=NULL,material_digest=NULL WHERE singleton=1 AND revision=?")
                    .run(input.expected.selector.revision + 1, input.expected.selector.revision);
                if (changed.changes !== 1)
                    throw new HubWebAddressError("stale");
                // Keep the directory epoch/head invariant. The separate address head fences old mounted sign-in flights.
                db.prepare("UPDATE hub_sessions SET state='ended' WHERE state='active'").run();
                db.prepare("INSERT INTO hub_web_address_operations VALUES(?,?)").run(input.id, JSON.stringify(input));
                const moved = db.prepare("UPDATE hub_web_address_head SET revision=?,operation_id=? WHERE singleton=1 AND revision=?")
                    .run(input.revision, input.id, input.expected.revision);
                if (moved.changes !== 1)
                    throw new HubWebAddressError("stale");
                return structuredClone(input);
            }).immediate();
        },
    };
}
export type HubWebAddressDecision = ReturnType<typeof createHubWebAddressDecision>;
