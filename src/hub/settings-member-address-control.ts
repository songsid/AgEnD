/** D3-owned orchestration: async preparation/probe, then the one shared synchronous sealed writer decision. */
import { X509Certificate } from "node:crypto";
import { z } from "zod";
import { canonicalArguments } from "./identity.js";
import { prepareMemberCertificate } from "./init/member-certificate.js";
import { readHubMemberTls } from "./tls.js";
import { parseHubMemberAddressCandidate, HubMemberAddressError } from "./settings-member-address-policy.js";
import { probeHubMemberAddress } from "./settings-member-address-network.js";
import type { HubSettingsWriter } from "./settings-commit.js";
import type { HubMemberAddressActor, HubMemberAddressDecision } from "./settings-member-address-decision.js";
import type { HubMemberAddressSummary } from "./settings-member-address.js";
export interface HubMemberAddressContext {
    actor: HubMemberAddressActor;
    ownerKey: object;
    authorityEpoch: number;
    current(): boolean;
}
const ref = z.strictObject({ ref: z.string().regex(/^[A-Za-z0-9_-]{32}$/) });
const obj = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
const same = (a: unknown, b: unknown) => canonicalArguments(a) === canonicalArguments(b);
export function createHubMemberAddressControl(deps: {
    home: string;
    readConfig(): unknown;
    writer: HubSettingsWriter;
    withDecision<T>(work: (decision: HubMemberAddressDecision) => T, current: () => boolean): Promise<T>;
    running(hub: unknown): boolean;
    settle(): Promise<void>;
    probe?: typeof probeHubMemberAddress;
}) {
    const prepared = new Map<string, {
        actor: HubMemberAddressActor;
        hub: unknown;
        candidate: ReturnType<typeof parseHubMemberAddressCandidate>;
        summary: HubMemberAddressSummary;
        expiresAt: number;
        ownerKey: object;
        authorityEpoch: number;
        current(): boolean;
    }>();
    const proof = (ctx: HubMemberAddressContext) => {
        if (ctx.actor.kind !== "host-owner" || ctx.current() !== true)
            throw new HubMemberAddressError("denied");
    };
    const writer = () => {
        if (!deps.writer.memberAddress)
            throw new HubMemberAddressError("unavailable");
        return deps.writer.memberAddress;
    };
    const source = () => structuredClone(obj(deps.readConfig()).hub);
    const info = (cert: string) => { const leaf = new X509Certificate(cert); return { fingerprint256: leaf.fingerprint256, validTo: leaf.validTo, selfSigned: leaf.subject === leaf.issuer && leaf.verify(leaf.publicKey) }; };
    return {
        async read(ctx: HubMemberAddressContext) {
            proof(ctx);
            const hub = obj(source()), current = () => ctx.current() === true && same(source(), hub);
            const snapshot = await deps.withDecision(d => { d.assertMounted(hub); return { certificate: info(readHubMemberTls({ home: deps.home }).certificatePem), fleets: d.affected() }; }, current);
            proof({ ...ctx, current });
            return { ok: true, origin: hub.memberOrigin, listen: hub.memberListen, ...snapshot };
        },
        async notices(ctx: HubMemberAddressContext, before?: number) {
            proof(ctx);
            const page = await deps.withDecision(d => d.notices({ kind: "host" }, ctx.current, before), ctx.current);
            proof(ctx); return page;
        },
        async acknowledge(id: string, ctx: HubMemberAddressContext) {
            proof(ctx);
            await deps.withDecision(d => d.acknowledge(id, { kind: "host" }, ctx.current), ctx.current);
            proof(ctx); return { ok: true };
        },
        async prepare(raw: unknown, ctx: HubMemberAddressContext) {
            proof(ctx);
            if (deps.writer.pending())
                throw new HubMemberAddressError("busy");
            const hub = source(), candidate = parseHubMemberAddressCandidate(raw, hub);
            const current = () => ctx.current() === true && same(source(), hub);
            const before = await deps.withDecision(d => ({ expected: d.inspect() }), current);
            proof({ ...ctx, current });
            const material = await prepareMemberCertificate(deps.home, candidate.origin);
            proof({ ...ctx, current });
            await (deps.probe ?? probeHubMemberAddress)(deps.readConfig(), candidate, deps.running(hub));
            proof({ ...ctx, current });
            const result = await deps.withDecision(d => {
                if (!same(d.inspect(), before.expected))
                    throw new HubMemberAddressError("stale");
                return writer().prepare({ origin: candidate.origin, listen: candidate.listen, certificate: material }, ctx.actor, current);
            }, current);
            proof({ ...ctx, current });
            for (const [k, p] of prepared)
                if (p.expiresAt <= Date.now())
                    prepared.delete(k);
            if (prepared.size >= 8)
                throw new HubMemberAddressError("busy");
            prepared.set(result.ref, { actor: { ...ctx.actor }, hub, candidate, summary: result.summary, expiresAt: result.expiresAt,
                ownerKey: ctx.ownerKey, authorityEpoch: ctx.authorityEpoch, current });
            return { ok: true, ...result, certificate: info(material) };
        },
        async commit(raw: unknown, ctx: HubMemberAddressContext) {
            proof(ctx);
            const input = ref.parse(raw), p = prepared.get(input.ref);
            prepared.delete(input.ref);
            if (!p || p.actor.sessionId !== ctx.actor.sessionId || p.ownerKey !== ctx.ownerKey || p.authorityEpoch !== ctx.authorityEpoch)
                throw new HubMemberAddressError("expired");
            const current = () => ctx.current() === true && p.current() === true && same(source(), p.hub);
            proof({ ...ctx, current });
            await (deps.probe ?? probeHubMemberAddress)(deps.readConfig(), p.candidate, deps.running(p.hub));
            proof({ ...ctx, current });
            let result: ReturnType<NonNullable<HubSettingsWriter["memberAddress"]>["commit"]>;
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
export type HubMemberAddressControl = ReturnType<typeof createHubMemberAddressControl>;
