/** Internal web-address operation of settings-commit.ts; one journal and one fleet configuration writer. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSecureContext } from "node:tls";
import { z } from "zod";
import { atomicWriteFileSync } from "../atomic-write.js";
import { ensurePrivateDirectory, privatePath, readPrivateFile } from "./private-files.js";
import { sealHubInitialization, verifyHubInitialization } from "./initialization.js";
import { hubPlanDigest } from "./init/plan-digest.js";
import { checkBrowserTls } from "./init/browser-tls.js";
import { parseHubWebAddressCandidate, HubWebAddressError, hubWebAddressBoundary } from "./settings-web-address-policy.js";
import { canonicalArguments } from "./identity.js";
import type { HubWebAddressActor, HubWebAddressDecision, HubWebAddressExpectation, HubWebAddressOperation } from "./settings-web-address-decision.js";
const manifest = "hub/init-manifest.json";
const obj = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
const canonical = (x: unknown): string => Array.isArray(x) ? `[${x.map(canonical).join(",")}]` : x && typeof x === "object"
    ? `{${Object.entries(x).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}` : JSON.stringify(x);
const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const actorSchema = z.strictObject({ kind: z.literal("host-owner"), sessionId: z.string().min(1).max(256), requestId: z.string().min(1).max(256) });
const inputSchema = z.strictObject({ origin: z.string(), listen: z.strictObject({ host: z.string(), port: z.number() }),
    certificate: z.strictObject({ cert: z.string().min(1).max(65536), key: z.string().min(1).max(16384) }) });
type Input = z.infer<typeof inputSchema>;
export interface HubWebAddressSummary {
    field: "web-address";
    from: string;
    to: string;
    listen: {
        host: string;
        port: number;
    };
    sessionsEnd: true;
}
export type HubWebAddressStep = "web-certificate" | "web-key" | "web-material" | "web-staged" | "web-decision" | "web-manifest" | "web-config" | "web-receipt" | "web-done" | "web-cleanup-journal" | "web-cleanup-stage";
export interface HubWebAddressSettingsWriter {
    /** Internal: the D3 controller supplies validated PEMs; the writer checks them again before deciding. */
    prepare(input: Input, actor: HubWebAddressActor, current: () => boolean): {
        ref: string;
        expiresAt: number;
        summary: HubWebAddressSummary;
    };
    commit(ref: string, actor: HubWebAddressActor, current: () => boolean): {
        receiptId: string;
        summary: HubWebAddressSummary;
    };
}
export interface HubWebAddressJournal {
    v: 3;
    op: "web-address";
    id: string;
    phase: "prepared" | "installing" | "done";
}
interface Stage {
    v: 1;
    id: string;
    operation: HubWebAddressOperation;
    next: Record<string, unknown>;
    manifest: string;
    receipt: string;
    certificateFile: string;
    keyFile: string;
}
interface Prepared {
    input: Input;
    actor: HubWebAddressActor;
    old: {
        hub: Record<string, unknown>;
        configSha: string;
        manifestSha: string;
    };
    expected: HubWebAddressExpectation;
    createdAt: number;
    expiresAt: number;
    current(): boolean;
}
interface Deps {
    home: string;
    journalPath: string;
    stagedPath: string;
    receiptsPath: string;
    readHub(): unknown;
    saveHub(patches: Array<{
        path: string[];
        value?: unknown;
        remove?: true;
    }>): void;
    decision(): HubWebAddressDecision | null;
    pending(): boolean;
    now(): number;
    step(name: HubWebAddressStep): void;
}
export function createHubWebAddressSettingsOperation(deps: Deps) {
    const refs = new Map<string, Prepared>(), file = (s: string) => join(deps.home, s);
    const read = (s: string, limit = 2 * 1024 * 1024) => readPrivateFile(deps.home, s, limit, { preserveBom: true });
    const flush = (s: string) => {
        let path = dirname(file(s));
        for (;;) {
            const fd = openSync(path, "r");
            try {
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            if (path === deps.home)
                break;
            const parent = dirname(path);
            if (parent === path)
                throw new HubWebAddressError("recovery");
            path = parent;
        }
    };
    const write = (suffix: string, text: string) => { ensurePrivateDirectory(deps.home, dirname(suffix)); atomicWriteFileSync(file(suffix), text, { mode: 0o600 }); privatePath(deps.home, suffix); flush(suffix); };
    const stagePath = (id: string) => `${deps.stagedPath}/${id}.web-address.json`;
    const decision = () => {
        const d = deps.decision();
        if (!d || d.hubId !== obj(deps.readHub()).hubId)
            throw new HubWebAddressError("unavailable");
        return d;
    };
    const proof = (current: () => boolean) => {
        const result: unknown = current();
        if (result !== true) {
            if (result && typeof (result as PromiseLike<unknown>).then === "function")
                void Promise.resolve(result).catch(() => { });
            throw new HubWebAddressError("denied");
        }
    };
    const image = () => {
        const hub = structuredClone(obj(deps.readHub()));
        if (typeof hub.hubId !== "string" || typeof hub.memberOrigin !== "string" || typeof hub.webOrigin !== "string")
            throw new HubWebAddressError("unavailable");
        const text = read(manifest, 65536);
        try {
            verifyHubInitialization({ home: deps.home, hubId: hub.hubId, memberOrigin: hub.memberOrigin, planDigest: hubPlanDigest(hub) });
        }
        catch {
            throw new HubWebAddressError("unavailable");
        }
        return { hub, configSha: sha(canonical(hub)), manifestSha: sha(text) };
    };
    const certificate = (input: Input) => {
        if (!checkBrowserTls(input.certificate.cert, input.certificate.key, input.origin, deps.now()).ok)
            throw new HubWebAddressError("certificate");
        try {
            createSecureContext(input.certificate);
        }
        catch {
            throw new HubWebAddressError("certificate");
        }
    };
    const actorSame = (a: HubWebAddressActor, b: HubWebAddressActor) => a.kind === b.kind && a.sessionId === b.sessionId;
    const summary = (p: Prepared): HubWebAddressSummary => ({ field: "web-address", from: p.old.hub.webOrigin as string, to: p.input.origin, listen: { ...p.input.listen }, sessionsEnd: true });
    const journal = (j: HubWebAddressJournal) => write(deps.journalPath, JSON.stringify(j) + "\n");
    const load = (j: HubWebAddressJournal): Stage => {
        let s: Stage;
        try {
            s = JSON.parse(read(stagePath(j.id))) as Stage;
        }
        catch {
            throw new HubWebAddressError("recovery");
        }
        const dir = `hub/web-address/${j.id}`;
        if (s.v !== 1 || s.id !== j.id || s.operation?.id !== j.id || s.certificateFile !== `${dir}/cert.pem` || s.keyFile !== `${dir}/key.pem`
            || s.operation.after.configSha !== sha(canonical(s.next)) || s.operation.after.manifestSha !== sha(s.manifest) || s.operation.receiptSha !== sha(s.receipt)
            || s.operation.after.certificateSha !== sha(read(s.certificateFile, 65536)) || s.operation.after.keySha !== sha(read(s.keyFile, 16384)))
            throw new HubWebAddressError("recovery");
        return s;
    };
    const cleanup = (j: HubWebAddressJournal, uncommitted = false) => {
        if (uncommitted) {
            const stage = load(j);
            if (sha(canonical(obj(deps.readHub()))) !== stage.operation.before.configSha || sha(read(manifest, 65536)) !== stage.operation.before.manifestSha)
                throw new HubWebAddressError("recovery");
            privatePath(deps.home, `hub/web-address/${j.id}`, true);
        }
        // Retire the recovery index durably before removing its input. A crash during
        // cleanup may leave an orphan stage, never a journal whose stage is gone.
        rmSync(file(deps.journalPath), { force: true });
        flush(deps.journalPath);
        deps.step("web-cleanup-journal");
        if (uncommitted)
            rmSync(file(`hub/web-address/${j.id}`), { recursive: true });
        rmSync(file(stagePath(j.id)), { force: true });
        flush(stagePath(j.id));
        deps.step("web-cleanup-stage");
    };
    const install = (j: HubWebAddressJournal, s: Stage) => {
        if (!same(load(j), s))
            throw new HubWebAddressError("recovery");
        const d = decision(), op = d.lookup(j.id);
        if (!op || !same(op, s.operation) || d.head().operationId !== op.id)
            throw new HubWebAddressError("recovery");
        d.assertOperation(op.id);
        const currentHub = obj(deps.readHub()), configSha = sha(canonical(currentHub)), manifestSha = sha(read(manifest, 65536));
        if (![op.before.configSha, op.after.configSha].includes(configSha) || ![op.before.manifestSha, op.after.manifestSha].includes(manifestSha))
            throw new HubWebAddressError("recovery");
        if (manifestSha !== op.after.manifestSha)
            write(manifest, s.manifest);
        deps.step("web-manifest");
        if (configSha !== op.after.configSha)
            deps.saveHub(["webOrigin", "webListen", "webTls", "webAddress"].map(k => ({ path: ["hub", k], value: structuredClone(s.next[k]) })));
        deps.step("web-config");
        if (sha(canonical(obj(deps.readHub()))) !== op.after.configSha || image().manifestSha !== op.after.manifestSha)
            throw new HubWebAddressError("recovery");
        write(`${deps.receiptsPath}/${j.id}.json`, s.receipt);
        deps.step("web-receipt");
        journal({ ...j, phase: "done" });
        deps.step("web-done");
        cleanup(j);
    };
    const api: HubWebAddressSettingsWriter = {
        prepare(raw, rawActor, current) {
            proof(current);
            const actor = actorSchema.parse(rawActor), input = inputSchema.parse(raw), old = image();
            const checked = parseHubWebAddressCandidate({ origin: input.origin, listen: input.listen, certificate: { mode: "keep" } }, old.hub);
            input.origin = checked.origin;
            certificate(input);
            const d = decision();
            d.assertMounted(old.hub);
            const expected = d.inspect();
            proof(current);
            if (!same(image(), old))
                throw new HubWebAddressError("stale");
            if (input.origin === old.hub.webOrigin && same(input.listen, old.hub.webListen) && same(input.certificate, d.material()))
                throw new HubWebAddressError("unchanged");
            const t = deps.now();
            for (const [k, p] of refs)
                if (t < p.createdAt || t >= p.expiresAt)
                    refs.delete(k);
            if (refs.size >= 8 || deps.pending())
                throw new HubWebAddressError("busy");
            const ref = randomBytes(24).toString("base64url"), p = { input, actor, old, expected, createdAt: t, expiresAt: t + 300000, current };
            refs.set(ref, p);
            return { ref, expiresAt: p.expiresAt, summary: summary(p) };
        },
        commit(ref, rawActor, current) {
            const p = refs.get(ref);
            refs.delete(ref);
            if (!p)
                throw new HubWebAddressError("expired");
            const actor = actorSchema.parse(rawActor), d = decision();
            const assert = () => {
                proof(current);
                proof(p.current);
                const t = deps.now();
                if (t < p.createdAt || t >= p.expiresAt)
                    throw new HubWebAddressError("expired");
                if (!actorSame(p.actor, actor) || !same(image(), p.old))
                    throw new HubWebAddressError("stale");
                certificate(p.input);
                return true;
            };
            assert();
            if (deps.pending())
                throw new HubWebAddressError("busy");
            if (!same(d.inspect(), p.expected))
                throw new HubWebAddressError("stale");
            const id = randomUUID(), dir = `hub/web-address/${id}`, certificateFile = `${dir}/cert.pem`, keyFile = `${dir}/key.pem`;
            const next = { ...p.old.hub, webOrigin: p.input.origin, webListen: p.input.listen, webTls: { certificateFile, keyFile }, webAddress: { operationId: id, revision: p.expected.revision + 1 } };
            const receipt = { v: 1, kind: "agend-hub-settings-receipt", id, op: "web-address", actor, hubId: d.hubId, oldDigest: hubPlanDigest(p.old.hub), newDigest: hubPlanDigest(next), at: new Date(deps.now()).toISOString() };
            const receiptText = JSON.stringify(receipt) + "\n", confirmationId = sha(canonical(receipt)).slice(0, 32), planDigest = hubPlanDigest(next), committedAt = receipt.at;
            const manifestText = JSON.stringify({ v: 1, hubId: d.hubId, planDigest, committedAt, confirmationId, signature: sealHubInitialization({ home: deps.home, planDigest, committedAt, confirmationId }) }) + "\n";
            const op: HubWebAddressOperation = { v: 1, kind: "web-address", id, expected: p.expected, revision: p.expected.revision + 1, before: { configSha: p.old.configSha, manifestSha: p.old.manifestSha },
                after: { configSha: sha(canonical(next)), manifestSha: sha(manifestText), certificateSha: sha(p.input.certificate.cert), keySha: sha(p.input.certificate.key), webSha: sha(canonicalArguments(hubWebAddressBoundary(next))) }, receiptSha: sha(receiptText), actor, at: deps.now() };
            write(certificateFile, p.input.certificate.cert);
            deps.step("web-certificate");
            write(keyFile, p.input.certificate.key);
            deps.step("web-key");
            const s: Stage = { v: 1, id, operation: op, next, manifest: manifestText, receipt: receiptText, certificateFile, keyFile };
            write(stagePath(id), JSON.stringify(s) + "\n");
            deps.step("web-material");
            const j: HubWebAddressJournal = { v: 3, op: "web-address", id, phase: "prepared" };
            journal(j);
            deps.step("web-staged");
            // The only decision: file journals are recovery indexes, not authority. Audit/TLS/session/head share this COMMIT.
            d.commit(op, () => { assert(); load(j); return true; });
            deps.step("web-decision");
            journal({ ...j, phase: "installing" });
            install(j, s);
            return { receiptId: id, summary: summary(p) };
        },
    };
    return { api, recover(j: HubWebAddressJournal) {
            const d = decision();
            if (!d.lookup(j.id)) {
                cleanup(j, true);
                return;
            }
            const s = load(j);
            install(j, s);
        } };
}
