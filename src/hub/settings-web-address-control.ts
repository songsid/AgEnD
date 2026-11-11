/** D3-owned orchestration: async preparation/probe, then the one shared synchronous sealed writer decision. */
import { X509Certificate } from "node:crypto";
import { relative } from "node:path";
import { z } from "zod";
import { canonicalArguments } from "./identity.js";
import { readPrivateFile } from "./private-files.js";
import { createBrowserCertificate, importBrowserCertificate } from "./init/browser-certificate.js";
import { parseHubWebAddressCandidate, HubWebAddressError } from "./settings-web-address-policy.js";
import { probeHubWebAddress } from "./settings-web-address-network.js";
import type { HubSettingsWriter } from "./settings-commit.js";
import type { HubWebAddressActor, HubWebAddressDecision } from "./settings-web-address-decision.js";
import type { HubWebAddressSummary } from "./settings-web-address.js";
export interface HubWebAddressContext {
    actor: HubWebAddressActor;
    ownerKey: object;
    authorityEpoch: number;
    current(): boolean;
}
const ref = z.strictObject({ ref: z.string().regex(/^[A-Za-z0-9_-]{32}$/) });
const obj = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
const same = (a: unknown, b: unknown) => canonicalArguments(a) === canonicalArguments(b);
export function createHubWebAddressControl(deps: {
    home: string;
    readConfig(): unknown;
    writer: HubSettingsWriter;
    withDecision<T>(work: (decision: HubWebAddressDecision) => T, current: () => boolean): Promise<T>;
    running(hub: unknown): boolean;
    settle(): Promise<void>;
    probe?: typeof probeHubWebAddress;
}) {
    const prepared = new Map<string, {
        actor: HubWebAddressActor;
        hub: unknown;
        candidate: ReturnType<typeof parseHubWebAddressCandidate>;
        summary: HubWebAddressSummary;
        expiresAt: number;
        ownerKey: object;
        authorityEpoch: number;
        current(): boolean;
    }>();
    const proof = (ctx: HubWebAddressContext) => {
        if (ctx.actor.kind !== "host-owner" || ctx.current() !== true)
            throw new HubWebAddressError("denied");
    };
    const writer = () => {
        if (!deps.writer.webAddress)
            throw new HubWebAddressError("unavailable");
        return deps.writer.webAddress;
    };
    const source = () => structuredClone(obj(deps.readConfig()).hub);
    const info = (cert: string) => { const leaf = new X509Certificate(cert); return { fingerprint256: leaf.fingerprint256, validTo: leaf.validTo, selfSigned: leaf.subject === leaf.issuer && leaf.verify(leaf.publicKey) }; };
    return {
        async read(ctx: HubWebAddressContext) {
            proof(ctx);
            const hub = obj(source()), current = () => ctx.current() === true && same(source(), hub);
            const certificate = await deps.withDecision(d => info(d.material().cert), current);
            proof({ ...ctx, current });
            return { ok: true, origin: hub.webOrigin, listen: hub.webListen, certificate };
        },
        async prepare(raw: unknown, ctx: HubWebAddressContext) {
            proof(ctx);
            if (deps.writer.pending())
                throw new HubWebAddressError("busy");
            const hub = source(), candidate = parseHubWebAddressCandidate(raw, hub);
            const current = () => ctx.current() === true && same(source(), hub);
            const before = await deps.withDecision(d => ({ expected: d.inspect(), material: d.material() }), current);
            proof({ ...ctx, current });
            let generated: Awaited<ReturnType<typeof createBrowserCertificate>> | undefined;
            try {
                let material = before.material;
                if (candidate.certificate.mode === "generate")
                    generated = await createBrowserCertificate(deps.home, candidate.origin);
                if (candidate.certificate.mode === "import")
                    generated = importBrowserCertificate(deps.home, candidate.origin, candidate.certificate);
                if (generated)
                    material = { cert: readPrivateFile(deps.home, relative(deps.home, generated.certFile), 65536), key: readPrivateFile(deps.home, relative(deps.home, generated.keyFile), 16384) };
                proof({ ...ctx, current });
                await (deps.probe ?? probeHubWebAddress)(deps.readConfig(), candidate, deps.running(hub));
                proof({ ...ctx, current });
                const result = await deps.withDecision(d => {
                    if (!same(d.inspect(), before.expected))
                        throw new HubWebAddressError("stale");
                    return writer().prepare({ origin: candidate.origin, listen: candidate.listen, certificate: material }, ctx.actor, current);
                }, current);
                proof({ ...ctx, current });
                for (const [k, p] of prepared)
                    if (p.expiresAt <= Date.now())
                        prepared.delete(k);
                if (prepared.size >= 8)
                    throw new HubWebAddressError("busy");
                prepared.set(result.ref, { actor: { ...ctx.actor }, hub, candidate, summary: result.summary, expiresAt: result.expiresAt,
                    ownerKey: ctx.ownerKey, authorityEpoch: ctx.authorityEpoch, current });
                return { ok: true, ...result, certificate: info(material.cert) };
            }
            finally {
                generated?.cleanup();
            }
        },
        async commit(raw: unknown, ctx: HubWebAddressContext) {
            proof(ctx);
            const input = ref.parse(raw), p = prepared.get(input.ref);
            prepared.delete(input.ref);
            if (!p || p.actor.sessionId !== ctx.actor.sessionId || p.ownerKey !== ctx.ownerKey || p.authorityEpoch !== ctx.authorityEpoch)
                throw new HubWebAddressError("expired");
            const current = () => ctx.current() === true && p.current() === true && same(source(), p.hub);
            proof({ ...ctx, current });
            await (deps.probe ?? probeHubWebAddress)(deps.readConfig(), p.candidate, deps.running(p.hub));
            proof({ ...ctx, current });
            let result: ReturnType<NonNullable<HubSettingsWriter["webAddress"]>["commit"]>;
            try {
                result = await deps.withDecision(() => writer().commit(input.ref, ctx.actor, current), current);
            }
            catch (error) {
                if (deps.writer.pending())
                    await deps.settle().catch(() => { });
                throw error;
            }
            // Never repeat the write after the decision. A bind race is saved-but-unavailable; old sessions are not restored.
            await deps.settle();
            proof(ctx);
            return { ok: true, ...result, origin: p.candidate.origin, state: obj(source()).enabled === false ? "off" : deps.running(source()) ? "ready" : "saved_unavailable" };
        },
    };
}
export type HubWebAddressControl = ReturnType<typeof createHubWebAddressControl>;
