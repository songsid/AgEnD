/** #3425: host-lifetime directory settings control. Authority is acquired by each listener, never by this DTO. */
import { z } from "zod";
import { canonicalArguments } from "./identity.js";
import { HubProtocolError, validated } from "./validation.js";
import { createHubDirectorySettingsProof, type HubDirectoryProofContext, type HubDirectoryProofDeps } from "./settings-directory-proof.js";
import { createHubDirectorySaveCoordinator, type HubDirectorySaveDeps, type HubDirectorySaveDelivery } from "./settings-directory-save.js";
import { parseHubDirectoryDecisionMetadata, type HubDirectoryDecisionRequest } from "./settings-directory-decision.js";
import { HUB_DIRECTORY_HOST_NOTICE_SINK } from "./settings-directory-notices.js";
import { createHubDirectorySettingsCa } from "./settings-directory-ca.js";

const text = (max: number) => z.string().min(1).max(max);
const editable = z.strictObject({ url: text(2048), baseDn: text(1024), bindDn: text(1024), caPem: text(64 * 1024).optional(),
  loginAttribute: text(64).optional(), userFilter: text(8192).optional(), timeoutMs: z.number().int().min(500).max(30_000).optional() });
const prepareRequest = z.strictObject({ directory: editable, bindPassword: text(4096).optional() });
const ref = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const refRequest = z.strictObject({ ref });
const testRequest = z.strictObject({ ref, confirmation: text(64).optional() });
const saveRequest = testRequest.extend({ credentials: z.strictObject({ login: text(256), password: text(4096) }).optional() });
const same = (a: unknown, b: unknown) => canonicalArguments(a) === canonicalArguments(b);

export interface HubDirectorySettingsControlDeps extends Omit<HubDirectorySaveDeps, "proof"> {
  createDirectory: HubDirectoryProofDeps["createDirectory"];
  /** Inert tests only. Production retains normal verified TLS. */
  probeTls?: HubDirectoryProofDeps["probeTls"];
}
export type HubDirectorySettingsControl = ReturnType<typeof createHubDirectorySettingsControl>;

export function createHubDirectorySettingsControl(options: HubDirectorySettingsControlDeps) {
  const deps = { ...options }, now = deps.now ?? Date.now;
  let stopped = false;
  const active = new Set<Promise<unknown>>(), owned = () => !stopped && deps.current() === true;
  const mounted = () => {
    const m = deps.mounted();
    if (!owned() || !m?.current() || m.decision.hubId !== deps.hubId) throw new HubProtocolError("unavailable");
    return m;
  };
  const context = (input: HubDirectoryProofContext): HubDirectoryProofContext => ({ actor: structuredClone(input.actor), current: input.current, signal: input.signal });
  const source = (ctx: HubDirectoryProofContext) => {
    if (ctx.signal?.aborted || ctx.current() !== true) throw new HubProtocolError("revoked");
    const m = mounted(), s = m.source();
    parseHubDirectoryDecisionMetadata({ actor: ctx.actor, changes: ["search"], recipients: [{ kind: "host", sink: HUB_DIRECTORY_HOST_NOTICE_SINK }] });
    if (ctx.actor.kind === "hub-administrator" && !same(ctx.actor.person, s.administrator)) throw new HubProtocolError("denied");
    if (!s.current() || !m.current() || !owned() || ctx.current() !== true) throw new HubProtocolError("revoked");
    return s;
  };
  const proof = createHubDirectorySettingsProof({ source: () => mounted().source(), writer: deps.writer, now,
    withDirectoryRead: (person, work) => mounted().withDirectoryRead(person, work), createDirectory: deps.createDirectory,
    recentAuthentication: actor => mounted().sessions().recentAuthentication(actor), ...(deps.probeTls ? { probeTls: deps.probeTls } : {}) });
  const save = createHubDirectorySaveCoordinator({ ...deps, proof });
  const ca = createHubDirectorySettingsCa({ source, now, withDirectoryRead: (person, work) => mounted().withDirectoryRead(person, work) });
  const track = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = Promise.resolve().then(() => { if (!owned()) throw new HubProtocolError("revoked"); return work(); });
    active.add(pending); void pending.finally(() => { active.delete(pending); }).catch(() => {}); return pending;
  };
  const fence = () => { stopped = true; ca.close(); save.fence(); };
  return {
    inspectCa(raw: unknown, input: HubDirectoryProofContext) {
      const request = structuredClone(raw), ctx = context(input); return track(() => ca.inspect(request, ctx));
    },
    fetchCa(raw: unknown, input: HubDirectoryProofContext) {
      const request = structuredClone(raw), ctx = context(input); return track(() => ca.fetch(request, ctx));
    },
    read(input: HubDirectoryProofContext) {
      const ctx = context(input), s = source(ctx);
      // The secret and its filesystem reference are never returned, even to the administrator or host owner.
      const { bindPasswordRef: _ref, ...directory } = structuredClone(s.config);
      const at = ctx.actor.kind === "hub-administrator" ? mounted().sessions().recentAuthentication(ctx.actor) : null, time = now();
      const reauthentication = ctx.actor.kind === "host-owner" ? "host" : at !== null && Number.isSafeInteger(time) && time >= at && time - at < 300_000 ? "recent" : "required";
      if (!s.current() || source(ctx).image !== s.image) throw new HubProtocolError("revoked");
      return { directory, bindPasswordSet: true, reauthentication };
    },
    prepare(raw: unknown, input: HubDirectoryProofContext) {
      const request = validated(prepareRequest, raw), ctx = context(input);
      return track(async () => {
        const s = source(ctx), directory = { realm: s.config.realm, profile: s.config.profile, ...request.directory };
        const changes: HubDirectoryDecisionRequest["changes"] = [];
        if (directory.url !== s.config.url) changes.push("server");
        if (directory.caPem !== s.config.caPem) changes.push("ca");
        if (directory.baseDn !== s.config.baseDn) changes.push("search");
        if (directory.bindDn !== s.config.bindDn) changes.push("service-account");
        if (request.bindPassword !== undefined) changes.push("secret");
        if (["loginAttribute", "userFilter", "timeoutMs"].some(key => directory[key as keyof typeof directory] !== s.config[key as keyof typeof s.config])) changes.push("query");
        if (!changes.length) throw new HubProtocolError("conflict");
        const result = await proof.prepare({ directory, ...(request.bindPassword === undefined ? {} : { bindPassword: request.bindPassword }), changes,
          recipients: [{ kind: "host", sink: HUB_DIRECTORY_HOST_NOTICE_SINK }, { kind: "person", person: { ...s.administrator } }] }, ctx);
        if (!s.current() || source(ctx).image !== s.image) throw new HubProtocolError("revoked");
        return result;
      });
    },
    test(raw: unknown, input: HubDirectoryProofContext) {
      const request = validated(testRequest, raw), ctx = context(input);
      return track(async () => { source(ctx); await proof.test(request.ref, request.confirmation, ctx); source(ctx); return { ok: true }; });
    },
    apply(raw: unknown, input: HubDirectoryProofContext, delivery?: HubDirectorySaveDelivery) {
      const request = validated(saveRequest, raw), ctx = context(input), captured = delivery && { capture: delivery.capture, rotation: delivery.rotation };
      return track(() => { source(ctx); return save.apply(request.ref, request, ctx, captured); });
    },
    cancel(raw: unknown, input: HubDirectoryProofContext) {
      const request = validated(refRequest, raw), ctx = context(input); source(ctx); proof.cancel(request.ref, ctx); return { ok: true };
    },
    fence,
    async close() { fence(); await Promise.allSettled([...active]); await save.close(); },
  };
}
