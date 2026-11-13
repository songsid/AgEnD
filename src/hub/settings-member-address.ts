/** Internal member-address operation of settings-commit.ts; one journal and one fleet configuration writer. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readHubMemberTls, parseHubIdentityMetadata, verifyHubCertificate } from "./tls.js";
import { z } from "zod";
import { atomicWriteFileSync } from "../atomic-write.js";
import { ensurePrivateDirectory, privatePath, readPrivateFile } from "./private-files.js";
import { sealHubInitialization, verifyHubInitialization } from "./initialization.js";
import { hubPlanDigest } from "./init/plan-digest.js";

import { parseHubMemberAddressCandidate, HubMemberAddressError, hubMemberAddressBoundary } from "./settings-member-address-policy.js";
import { canonicalArguments } from "./identity.js";
import type { HubMemberAddressActor, HubMemberAddressDecision, HubMemberAddressExpectation, HubMemberAddressOperation, HubMemberAddressRelocation } from "./settings-member-address-decision.js";
const manifest = "hub/init-manifest.json";
const obj = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
const canonical = (x: unknown): string => Array.isArray(x) ? `[${x.map(canonical).join(",")}]` : x && typeof x === "object"
    ? `{${Object.entries(x).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}` : JSON.stringify(x);
const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const actorSchema = z.strictObject({ kind: z.literal("host-owner"), sessionId: z.string().min(1).max(256), requestId: z.string().min(1).max(256) });
const inputSchema = z.strictObject({ origin: z.string(), listen: z.strictObject({ host: z.string(), port: z.number() }),
    certificate: z.string().min(1).max(65536) });
type Input = z.infer<typeof inputSchema>;
export interface HubMemberAddressSummary {
    field: "member-address";
    from: string;
    to: string;
    listen: {
        host: string;
        port: number;
    };
    fleetsRejoin: true;
    fleets: HubMemberAddressOperation["affected"];
}
export type HubMemberAddressStep = "member-certificate" | "member-identity" | "member-material" | "member-staged" | "member-decision" | "member-manifest" | "member-config" | "member-receipt" | "member-done" | "member-cleanup-journal" | "member-cleanup-stage";
export interface HubMemberAddressSettingsWriter {
    /** Internal: the D3 controller supplies validated PEMs; the writer checks them again before deciding. */
    prepare(input: Input, actor: HubMemberAddressActor, current: () => boolean): {
        ref: string;
        expiresAt: number;
        summary: HubMemberAddressSummary;
    };
    /** #3429 B: `relocation` names the Fleets that followed (kept); every other affected Fleet is revoked as before. */
    commit(ref: string, actor: HubMemberAddressActor, current: () => boolean, relocation?: HubMemberAddressRelocation): {
        receiptId: string;
        summary: HubMemberAddressSummary;
    };
}
export interface HubMemberAddressJournal {
    v: 4;
    op: "member-address";
    id: string;
    phase: "prepared" | "installing" | "done";
}
interface Stage {
    v: 1;
    id: string;
    operation: HubMemberAddressOperation;
    next: Record<string, unknown>;
    manifest: string;
    receipt: string;
    certificateFile: string;
    identity: string;
}
interface Prepared {
    input: Input;
    actor: HubMemberAddressActor;
    old: {
        hub: Record<string, unknown>;
        configSha: string;
        manifestSha: string;
        identitySha: string;
    };
    fleets: HubMemberAddressOperation["affected"];
    expected: HubMemberAddressExpectation;
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
    decision(): HubMemberAddressDecision | null;
    pending(): boolean;
    now(): number;
    step(name: HubMemberAddressStep): void;
}
export function createHubMemberAddressSettingsOperation(deps: Deps) {
    const root = resolve(deps.home);
    const refs = new Map<string, Prepared>(), file = (s: string) => join(root, s);
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
            if (path === root)
                break;
            const parent = dirname(path);
            if (parent === path)
                throw new HubMemberAddressError("recovery");
            path = parent;
        }
    };
    const write = (suffix: string, text: string) => { ensurePrivateDirectory(deps.home, dirname(suffix)); atomicWriteFileSync(file(suffix), text, { mode: 0o600 }); privatePath(deps.home, suffix); flush(suffix); };
    const stagePath = (id: string) => `${deps.stagedPath}/${id}.member-address.json`;
    const decision = () => {
        const d = deps.decision();
        if (!d || d.hubId !== obj(deps.readHub()).hubId)
            throw new HubMemberAddressError("unavailable");
        return d;
    };
    const proof = (current: () => boolean) => {
        const result: unknown = current();
        if (result !== true) {
            if (result && typeof (result as PromiseLike<unknown>).then === "function")
                void Promise.resolve(result).catch(() => { });
            throw new HubMemberAddressError("denied");
        }
    };
    const image = () => {
        const hub = structuredClone(obj(deps.readHub()));
        if (typeof hub.hubId !== "string" || typeof hub.memberOrigin !== "string" || typeof hub.webOrigin !== "string")
            throw new HubMemberAddressError("unavailable");
        const text = read(manifest, 65536);
        try {
            verifyHubInitialization({ home: deps.home, hubId: hub.hubId, memberOrigin: hub.memberOrigin, planDigest: hubPlanDigest(hub) });
        }
        catch {
            throw new HubMemberAddressError("unavailable");
        }
        return { hub, configSha: sha(canonical(hub)), manifestSha: sha(text), identitySha: sha(readHubMemberTls({ home: deps.home, memberOrigin: hub.memberOrigin }).metadataText) };
    };
    const certificate = (input: Input) => {
        const material = readHubMemberTls({ home: deps.home });
        try { verifyHubCertificate(input.certificate, input.origin, material.identity.spkiSha256, deps.now()); }
        catch { throw new HubMemberAddressError("certificate"); }
    };
    const actorSame = (a: HubMemberAddressActor, b: HubMemberAddressActor) => a.kind === b.kind && a.sessionId === b.sessionId;
    const summary = (p: Prepared): HubMemberAddressSummary => ({ field: "member-address", from: p.old.hub.memberOrigin as string, to: p.input.origin, listen: { ...p.input.listen }, fleetsRejoin: true, fleets: structuredClone(p.fleets) });
    const journal = (j: HubMemberAddressJournal) => write(deps.journalPath, JSON.stringify(j) + "\n");
    const load = (j: HubMemberAddressJournal): Stage => {
        let s: Stage;
        try {
            s = JSON.parse(read(stagePath(j.id))) as Stage;
        }
        catch {
            throw new HubMemberAddressError("recovery");
        }
        const dir = `hub/member-address/${j.id}`;
        if (s.v !== 1 || s.id !== j.id || s.operation?.id !== j.id || s.certificateFile !== `${dir}/cert.pem`
            || s.operation.after.configSha !== sha(canonical(s.next)) || s.operation.after.manifestSha !== sha(s.manifest) || s.operation.receiptSha !== sha(s.receipt)
            || s.operation.after.certificateSha !== sha(read(s.certificateFile, 65536)) || s.operation.after.identitySha !== sha(s.identity))
            throw new HubMemberAddressError("recovery");
        const metadata = parseHubIdentityMetadata(JSON.parse(s.identity));
        if (metadata.v !== 2 || metadata.certificateFile !== s.certificateFile || metadata.memberOrigin !== s.next.memberOrigin
            || metadata.hubId !== s.operation.expected.hubId || metadata.spkiSha256 !== s.operation.expected.spkiSha256 || metadata.issuerKeyId !== s.operation.expected.issuerKeyId)
            throw new HubMemberAddressError("recovery");
        verifyHubCertificate(read(s.certificateFile, 65536), metadata.memberOrigin, metadata.spkiSha256, deps.now());
        return s;
    };
    const cleanup = (j: HubMemberAddressJournal, uncommitted = false) => {
        if (uncommitted) {
            const stage = load(j);
            if (sha(canonical(obj(deps.readHub()))) !== stage.operation.before.configSha || sha(read(manifest, 65536)) !== stage.operation.before.manifestSha || sha(read("hub/keys/identity.json")) !== stage.operation.before.identitySha)
                throw new HubMemberAddressError("recovery");
            privatePath(deps.home, `hub/member-address/${j.id}`, true);
        }
        // Retire the recovery index durably before removing its input. A crash during
        // cleanup may leave an orphan stage, never a journal whose stage is gone.
        rmSync(file(deps.journalPath), { force: true });
        flush(deps.journalPath);
        deps.step("member-cleanup-journal");
        if (uncommitted)
            rmSync(file(`hub/member-address/${j.id}`), { recursive: true });
        rmSync(file(stagePath(j.id)), { force: true });
        flush(stagePath(j.id));
        deps.step("member-cleanup-stage");
    };
    const install = (j: HubMemberAddressJournal, s: Stage) => {
        if (!same(load(j), s))
            throw new HubMemberAddressError("recovery");
        const d = decision(), op = d.lookup(j.id);
        if (!op || !same(op, s.operation) || d.head().operationId !== op.id)
            throw new HubMemberAddressError("recovery");
        d.assertOperation(op.id);
        const currentHub = obj(deps.readHub()), configSha = sha(canonical(currentHub)), manifestSha = sha(read(manifest, 65536));
        if (![op.before.configSha, op.after.configSha].includes(configSha) || ![op.before.manifestSha, op.after.manifestSha].includes(manifestSha))
            throw new HubMemberAddressError("recovery");
        const material = readHubMemberTls({ home: deps.home }), identitySha = sha(material.metadataText);
        if (![op.before.identitySha, op.after.identitySha].includes(identitySha) || sha(material.keyPem) !== op.expected.keySha
            || material.identity.hubId !== op.expected.hubId || material.identity.issuerKeyId !== op.expected.issuerKeyId) throw new HubMemberAddressError("recovery");
        if (identitySha !== op.after.identitySha) write("hub/keys/identity.json", s.identity);
        deps.step("member-identity");
        if (manifestSha !== op.after.manifestSha)
            write(manifest, s.manifest);
        deps.step("member-manifest");
        if (configSha !== op.after.configSha)
            deps.saveHub(["memberOrigin", "memberListen", "memberAddress"].map(k => ({ path: ["hub", k], value: structuredClone(s.next[k]) })));
        deps.step("member-config");
        if (sha(canonical(obj(deps.readHub()))) !== op.after.configSha || image().manifestSha !== op.after.manifestSha)
            throw new HubMemberAddressError("recovery");
        write(`${deps.receiptsPath}/${j.id}.json`, s.receipt);
        deps.step("member-receipt");
        journal({ ...j, phase: "done" });
        deps.step("member-done");
        cleanup(j);
    };
    const api: HubMemberAddressSettingsWriter = {
        prepare(raw, rawActor, current) {
            proof(current);
            const actor = actorSchema.parse(rawActor), input = inputSchema.parse(raw), old = image();
            const checked = parseHubMemberAddressCandidate({ origin: input.origin, listen: input.listen }, old.hub);
            input.origin = checked.origin;
            certificate(input);
            const d = decision();
            d.assertMounted(old.hub);
            const expected = d.inspect();
            proof(current);
            if (!same(image(), old))
                throw new HubMemberAddressError("stale");
            if (input.origin === old.hub.memberOrigin && same(input.listen, old.hub.memberListen))
                throw new HubMemberAddressError("unchanged");
            const t = deps.now();
            for (const [k, p] of refs)
                if (t < p.createdAt || t >= p.expiresAt)
                    refs.delete(k);
            if (refs.size >= 8 || deps.pending())
                throw new HubMemberAddressError("busy");
            const ref = randomBytes(24).toString("base64url"), p = { input, actor, old, expected, fleets: d.affected(), createdAt: t, expiresAt: t + 300000, current };
            refs.set(ref, p);
            return { ref, expiresAt: p.expiresAt, summary: summary(p) };
        },
        commit(ref, rawActor, current, relocation) {
            const p = refs.get(ref);
            refs.delete(ref);
            if (!p)
                throw new HubMemberAddressError("expired");
            const actor = actorSchema.parse(rawActor), d = decision();
            const assert = () => {
                proof(current);
                proof(p.current);
                const t = deps.now();
                if (t < p.createdAt || t >= p.expiresAt)
                    throw new HubMemberAddressError("expired");
                if (!actorSame(p.actor, actor) || !same(image(), p.old))
                    throw new HubMemberAddressError("stale");
                certificate(p.input);
                return true;
            };
            assert();
            if (deps.pending())
                throw new HubMemberAddressError("busy");
            if (!same(d.inspect(), p.expected))
                throw new HubMemberAddressError("stale");
            const id = randomUUID(), dir = `hub/member-address/${id}`, certificateFile = `${dir}/cert.pem`;
            const material = readHubMemberTls({ home: deps.home });
            const identityText = JSON.stringify({ ...material.metadata, v: 2, memberOrigin: p.input.origin, certificateFile }) + "\n";
            const next = { ...p.old.hub, memberOrigin: p.input.origin, memberListen: p.input.listen, memberAddress: { operationId: id, revision: p.expected.revision + 1 } };
            const receipt = { v: 1, kind: "agend-hub-settings-receipt", id, op: "member-address", actor, hubId: d.hubId, oldDigest: hubPlanDigest(p.old.hub), newDigest: hubPlanDigest(next), at: new Date(deps.now()).toISOString() };
            const receiptText = JSON.stringify(receipt) + "\n", confirmationId = sha(canonical(receipt)).slice(0, 32), planDigest = hubPlanDigest(next), committedAt = receipt.at;
            const manifestText = JSON.stringify({ v: 1, hubId: d.hubId, planDigest, committedAt, confirmationId, signature: sealHubInitialization({ home: deps.home, planDigest, committedAt, confirmationId }) }) + "\n";
            const op: HubMemberAddressOperation = { v: 1, kind: "member-address", id, expected: p.expected, revision: p.expected.revision + 1, before: { configSha: p.old.configSha, manifestSha: p.old.manifestSha, identitySha: p.old.identitySha },
                after: { configSha: sha(canonical(next)), manifestSha: sha(manifestText), certificateSha: sha(p.input.certificate), identitySha: sha(identityText), memberSha: sha(canonicalArguments(hubMemberAddressBoundary(next))) }, receiptSha: sha(receiptText), actor, at: deps.now(), webOrigin: p.old.hub.webOrigin as string, affected: p.fleets, administrator: p.old.hub.administrator as HubMemberAddressOperation["administrator"], ...(relocation ? { relocation } : {}) };
            write(certificateFile, p.input.certificate);
            deps.step("member-certificate");
            const s: Stage = { v: 1, id, operation: op, next, manifest: manifestText, receipt: receiptText, certificateFile, identity: identityText };
            write(stagePath(id), JSON.stringify(s) + "\n");
            deps.step("member-material");
            const j: HubMemberAddressJournal = { v: 4, op: "member-address", id, phase: "prepared" };
            journal(j);
            deps.step("member-staged");
            // The only decision: file journals are recovery indexes, not authority. Revocation/audit/notices/head share this COMMIT.
            d.commit(op, () => { assert(); load(j); return true; });
            deps.step("member-decision");
            journal({ ...j, phase: "installing" });
            install(j, s);
            return { receiptId: id, summary: summary(p) };
        },
    };
    return { api, recover(j: HubMemberAddressJournal) {
            const d = decision();
            if (!d.lookup(j.id)) {
                cleanup(j, true);
                return;
            }
            const s = load(j);
            install(j, s);
        } };
}
