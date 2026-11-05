/** Restricted TLS bootstrap: no directory password, bearer credential, inventory or work travels here. */
import { request } from "node:https";
import type { TLSSocket } from "node:tls";
import { createPublicKey } from "node:crypto";
import { z } from "zod";
import { hubOrigin, verifyHubCertificate, pinnedHubAgent } from "./tls.js";
import { parseStrictJson, validated, token, uuid, HubProtocolError } from "./validation.js";
import { HUB_PATHS } from "./protocol.js";
import { issuerKeyId, sha256 } from "./identity.js";
import { HubMemberProfileStore, pendingSchema, validateHubBinding, type HubPendingPairing } from "./profile.js";
async function post(origin: string, path: string, body: unknown, pinned?: { certificatePem: string; spkiSha256: string }): Promise<{ value: unknown; certificatePem: string }> {
  const normalized = hubOrigin(origin), bytes = JSON.stringify(body);
  if (Buffer.byteLength(bytes) > 2048) throw new HubProtocolError();
  return new Promise((resolve, reject) => {
    let certificatePem = "", done = false;
    const agent = pinned ? pinnedHubAgent({ memberOrigin: normalized, spkiSha256: pinned.spkiSha256 }) : undefined;
    let deadline: NodeJS.Timeout | undefined;
    const fail = () => { if (!done) { done = true; clearTimeout(deadline); agent?.destroy(); req.destroy(); reject(new HubProtocolError("unavailable")); } };
    const req = request(new URL(path, normalized), { method: "POST", agent: agent ?? false, rejectUnauthorized: false, minVersion: "TLSv1.2", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bytes) }, timeout: 5_000 }, res => {
      const chunks: Buffer[] = []; let total = 0;
      res.on("data", part => { total += part.length; if (total > 32 * 1024) { fail(); return; } chunks.push(Buffer.from(part)); });
      res.on("aborted", fail); res.on("error", fail);
      res.on("end", () => {
        if (done) return;
        if (res.statusCode !== 200 || !certificatePem) { fail(); return; }
        try { const value = parseStrictJson(Buffer.concat(chunks), 32 * 1024); done = true; clearTimeout(deadline); agent?.destroy(); resolve({ value, certificatePem }); } catch { fail(); }
      });
    });
    req.on("socket", raw => {
      const socket = raw as TLSSocket;
      const examined = () => {
        try {
          const cert = verifyHubCertificate(socket.getPeerCertificate().raw, normalized, pinned?.spkiSha256);
          certificatePem = cert.toString(); req.end(bytes);
        } catch { fail(); }
      };
      if (socket.getPeerCertificate()?.raw) examined(); else socket.once("secureConnect", examined);
    });
    deadline = setTimeout(fail, 5_000); deadline.unref();
    req.on("timeout", fail); req.on("error", fail);
    // No .end until the exact peer certificate has been examined; redirects are never followed.
  });
}
/** Persists only a pending claim. current is a Settings-owned local-owner continuation, never a browser boolean. */
export async function beginHubPairing(input: { home: string; memberOrigin: string; code: string; current(): boolean }): Promise<HubPendingPairing> {
  if (!input.current() || !/^[a-f0-9]{12}$/.test(input.code)) throw new HubProtocolError("denied");
  const origin = hubOrigin(input.memberOrigin), response = await post(origin, HUB_PATHS.pair, { code: input.code });
  if (!input.current() || !response.value || typeof response.value !== "object" || Array.isArray(response.value)) throw new HubProtocolError("stale");
  const p = validated(pendingSchema, { v: 1, ...response.value, certificatePem: response.certificatePem });
  validateHubBinding(p);
  if (p.hub.memberOrigin !== origin || p.expiresAt <= Date.now() || p.expiresAt > Date.now() + 600_000 || p.fingerprint !== sha256(JSON.stringify(["agend-hub-pair-v1", p.hub.hubId, p.hub.memberOrigin, p.hub.spkiSha256, p.hub.issuerPublicKey, p.hub.webOrigin, p.pairingId, p.owner.realm, p.owner.objectId, sha256(p.claimSecret)]))) throw new HubProtocolError("denied");
  new HubMemberProfileStore(input.home, p.hub.hubId).savePending(p, input.current); return p;
}
export async function claimHubPairing(input: { home: string; hubId: string; approvedFingerprint: string; expectedProfileDigest: string | null; current(): boolean }): Promise<{ status: "pending" | "paired" }> {
  const store = new HubMemberProfileStore(input.home, input.hubId), pending = store.readPending();
  if (!input.current() || pending.fingerprint !== input.approvedFingerprint || pending.expiresAt <= Date.now()) throw new HubProtocolError("stale");
  const response = await post(pending.hub.memberOrigin, HUB_PATHS.claim, { pairingId: pending.pairingId, fleetId: pending.fleetId, claimSecret: pending.claimSecret }, { certificatePem: pending.certificatePem, spkiSha256: pending.hub.spkiSha256 });
  if (!input.current()) throw new HubProtocolError("stale");
  const result = validated(z.union([z.strictObject({ status: z.literal("pending") }), z.strictObject({ status: z.literal("approved"), fleetId: uuid, credential: token })]), response.value);
  if (result.status === "pending") return { status: "pending" };
  if (result.fleetId !== pending.fleetId || store.readPending().fingerprint !== pending.fingerprint) throw new HubProtocolError("stale");
  store.saveProfile({ v: 1, hub: pending.hub, owner: pending.owner, fleetId: pending.fleetId, credential: result.credential,
    certificatePem: pending.certificatePem, issuerKeyId: issuerKeyId(createPublicKey(pending.hub.issuerPublicKey)) }, input.expectedProfileDigest, input.current);
  store.clearPending(); return { status: "paired" }; // a save failure leaves an explicit unresolved claim; never retry credential issuance
}
