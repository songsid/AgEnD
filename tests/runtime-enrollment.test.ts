import * as fixturePrivacyFs from "node:fs";
import { createServer, IncomingMessage, ServerResponse, type Server } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import { generateKeyPairSync, createHash, randomBytes, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeCoordinator, maskedSource, type RuntimeEnrollmentAuditEntry } from "../src/runtime-coordinator.js";
import { enrolledRuntimeNotice } from "../src/runtime-enroll-notice.js";
import { handleRuntimeRequest, type RuntimeApiContext } from "../src/runtime-api.js";
import { ENROLL_IDENTITY_FILE, ENROLL_TTL_MS, generateEnrollToken, hashEnrollToken, loadRuntimeServerIdentity } from "../src/runtime-enrollment.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WEB_SESSION_COOKIE } from "../src/web-auth.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { describeEnrollRefusal, enrollRuntime } from "../src/runtime-client.js";
import { RUNTIME_ENROLL_PATH, RUNTIME_ENROLL_HELLO_PATH, RUNTIME_ENROLL_TOKEN_PATTERN, runtimeEnrollHelloMessage, runtimeEnrollTokenId, runtimeServerFingerprint, verifyRuntimeServerProof, newRuntimeEnrollEphemeral, runtimeEnrollChannel, sealRuntimeEnroll, openRuntimeEnroll } from "../src/runtime-protocol.js";

/**
 * one-time install-command tokens. The server only keeps a hash, the token works once and for 15 minutes, a new token (or a revoke) ends
 * the old one, every issue/use/revoke is recorded, the Runtime proves who the server is before it sends the token, and nothing secret is left in a file.
 */
const homes: string[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [], clients: WebSocket[] = [];
const ACTOR = "admin:0123456789abcdef";
function home() { const value = mkdtempSync(join(tmpdir(), "agend-runtime-enroll-")); homes.push(value); return value; }
function hub(options: ConstructorParameters<typeof RuntimeCoordinator>[1] = {}, dir = home()) { const value = new RuntimeCoordinator(dir, options); hubs.push(value); return value; }
async function listen(h: RuntimeCoordinator, log: string[] = []) {
  const server = createServer((req, res) => { log.push(`${req.method} ${req.url}`); if (!h.handlePublicRequest(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); } });
  servers.push(server); server.on("upgrade", (req, socket, head) => { if (!h.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw Error("No test port");
  return `http://127.0.0.1:${address.port}`;
}
const nonce = (): string => "ab".repeat(16);
function enrollInput(h: RuntimeCoordinator, token: string, extra: Record<string, unknown> = {}) { return { token, fingerprint: h.serverFingerprint(), name: "Desk", platform: "win32", ...extra }; }
async function postJson(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
/**
 * What a Runtime does, by hand, so the public routes can be driven without the client: hello, check the proof, seal the request to the fresh key, send it, open the
 * sealed answer. `options.tid` overrides the id sent (to test the rate buckets); `options.nonce` the nonce.
 */
async function sealedEnroll(base: string, fields: Record<string, unknown>, options: { nonce?: string; tid?: string } = {}) {
  const token = typeof fields.token === "string" ? fields.token : "", id = options.tid ?? (token.startsWith("agend_enroll_") ? runtimeEnrollTokenId(token) : "0".repeat(16)), n = options.nonce ?? randomBytes(24).toString("hex");
  const hello = await postJson(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: n, tid: id });
  if (hello.status !== 200) return { hello, answer: hello, opened: undefined as undefined | Record<string, unknown> };
  const ephemeral = String(hello.body.ephemeral), mine = newRuntimeEnrollEphemeral(), channel = runtimeEnrollChannel(mine.privateKey, ephemeral, n, id, ephemeral, mine.publicKey);
  const box = sealRuntimeEnroll(channel.requestKey, channel.context, "request", Buffer.from(JSON.stringify(fields), "utf8"));
  const answer = await postJson(base, RUNTIME_ENROLL_PATH, { nonce: n, tid: id, clientKey: mine.publicKey, ...box });
  const opened = answer.status === 201 ? JSON.parse(openRuntimeEnroll(channel.replyKey, channel.context, "reply", answer.body.box)!.toString("utf8")) as Record<string, unknown> : undefined;
  return { hello, answer, opened };
}
/** Every file under a folder, as text, so "the token is nowhere on disk" can be checked for the whole data and profile folders. */
function everyFile(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) if (entry.isFile()) out.push(readFileSync(join(entry.parentPath, entry.name), "utf8"));
  return out;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const ws of clients.splice(0)) ws.terminate();
  for (const h of hubs.splice(0)) h.close();
  for (const s of servers.splice(0)) await new Promise<void>(done => s.close(() => done()));
  for (const path of homes.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test cleanup"); rmSync(path, { recursive: true, force: true }); }
});

describe("the token and the server identity", () => {
  it("is 256 random bits behind a fixed prefix, and no two are alike", () => {
    const tokens = new Set(Array.from({ length: 64 }, generateEnrollToken));
    expect(tokens.size).toBe(64);
    for (const token of tokens) { expect(token).toMatch(RUNTIME_ENROLL_TOKEN_PATTERN); expect(Buffer.from(token.slice("agend_enroll_".length), "base64url")).toHaveLength(32); }
    expect(hashEnrollToken("agend_enroll_" + "A".repeat(43))).toMatch(/^[a-f0-9]{64}$/);
  });
  it("creates the enrollment key once, privately, and finds the same one again", () => {
    const dir = home(), first = loadRuntimeServerIdentity(dir), again = loadRuntimeServerIdentity(dir);
    expect(again.fingerprint).toBe(first.fingerprint); expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    if (process.platform !== "win32") expect(statSync(join(dir, ENROLL_IDENTITY_FILE)).mode & 0o077).toBe(0);
    expect(loadRuntimeServerIdentity(home()).fingerprint).not.toBe(first.fingerprint);
  });
  it("never replaces an odd identity file (that would change the fingerprint under every command already handed out)", () => {
    const dir = home(); writeFileSync(join(dir, ENROLL_IDENTITY_FILE), "{\"version\":2}");
    expect(() => loadRuntimeServerIdentity(dir)).toThrow(/Malformed/);
    expect(readFileSync(join(dir, ENROLL_IDENTITY_FILE), "utf8")).toBe("{\"version\":2}");
  });
  it("signs a nonce so the key's fingerprint and the signature can both be checked, and nothing else passes", () => {
    const key = newRuntimeEnrollEphemeral().publicKey, identity = loadRuntimeServerIdentity(home()), message = runtimeEnrollHelloMessage(nonce(), key), signature = identity.signature(message);
    expect(verifyRuntimeServerProof(identity.fingerprint, identity.publicKey, signature, message)).toBe(true);
    expect(verifyRuntimeServerProof("0".repeat(64), identity.publicKey, signature, message)).toBe(false);                           // another fingerprint
    expect(verifyRuntimeServerProof(identity.fingerprint, identity.publicKey, signature, runtimeEnrollHelloMessage("cd".repeat(16), key))).toBe(false); // another nonce
    expect(verifyRuntimeServerProof(identity.fingerprint, identity.publicKey, signature, runtimeEnrollHelloMessage(nonce(), newRuntimeEnrollEphemeral().publicKey))).toBe(false); // another fresh key: the signature covers it
    expect(verifyRuntimeServerProof(identity.fingerprint, identity.publicKey, "AAAA", message)).toBe(false);
    for (const hostile of [undefined, 1, "", "!!!", "x".repeat(300)]) expect(verifyRuntimeServerProof(identity.fingerprint, hostile, signature, message)).toBe(false);
    // a different key that someone made to look right still fails the fingerprint pin
    const other = generateKeyPairSync("ed25519"), der = other.publicKey.export({ type: "spki", format: "der" });
    expect(verifyRuntimeServerProof(identity.fingerprint, der.toString("base64url"), sign(null, message, other.privateKey).toString("base64url"), message)).toBe(false);
    expect(runtimeServerFingerprint(der)).not.toBe(identity.fingerprint);
  });
});

describe("issuing, using, expiring and revoking a token", () => {
  it("keeps only the token's hash: not the token, not on disk, not in the list the page reads", () => {
    const h = hub(), issued = h.createEnrollment(ACTOR);
    expect(issued.token).toMatch(RUNTIME_ENROLL_TOKEN_PATTERN); expect(issued.fingerprint).toBe(h.serverFingerprint()); expect(issued.expiresAt - issued.createdAt).toBe(ENROLL_TTL_MS);
    const raw = readFileSync(join(homes[0], "runtime-machines.json"), "utf8");
    expect(raw).not.toContain(issued.token); expect(raw).not.toContain(issued.token.slice("agend_enroll_".length)); expect(raw).toContain(hashEnrollToken(issued.token));
    const listed = JSON.stringify(h.listEnrollments());
    expect(listed).not.toContain(issued.token); expect(listed).not.toContain(hashEnrollToken(issued.token)); expect(listed).not.toMatch(/Hash|token/i);
    expect(h.listEnrollments()).toEqual([{ id: issued.id, status: "unused", createdAt: issued.createdAt, expiresAt: issued.expiresAt }]);
  });
  it("is good for 15 minutes by default", () => { expect(ENROLL_TTL_MS).toBe(15 * 60_000); });
  it("creates an already-approved computer with a credential, once, and stores that credential only as a hash", () => {
    const h = hub(), { token, id } = h.createEnrollment(ACTOR), result = h.enroll(enrollInput(h, token, { hostname: "DESK-1" }));
    expect(result).toMatchObject({ status: "enrolled" }); expect(result.credential).toMatch(/^[a-f0-9]{64}$/);
    const machine = h.machine(result.machineId)!;
    expect(machine).toMatchObject({ name: "Desk", status: "offline", enrolledVia: "install-command", enrollmentId: id, hostname: "DESK-1" }); expect(machine.approvedAt).toBeTypeOf("number");
    expect(machine.pairingFingerprint).toBeUndefined();                                                      // no fingerprint to compare, nothing to approve
    expect(h.listEnrollments()[0]).toMatchObject({ id, status: "used", machineId: result.machineId });
    const raw = readFileSync(join(homes[0], "runtime-machines.json"), "utf8");
    expect(raw).not.toContain(result.credential); expect(raw).not.toContain(token);
    expect(JSON.stringify(h.listMachines())).not.toMatch(/credentialHash|claimHash|Secret/);
  });
  it("refuses a second use of the same token, and the machine of the first stays", () => {
    const h = hub(), { token } = h.createEnrollment(ACTOR), first = h.enroll(enrollInput(h, token));
    let refusal: unknown; try { h.enroll(enrollInput(h, token, { name: "Second" })); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ reason: "used" }); expect(String((refusal as Error).message)).not.toContain(token);
    expect(h.listMachines().map(machine => machine.id)).toEqual([first.machineId]);
  });
  it("refuses an expired token, a revoked one, and one that was never issued, each with its own reason", () => {
    let now = 1_000_000; const h = hub({ now: () => now }), a = h.createEnrollment(ACTOR);
    now += ENROLL_TTL_MS - 1; expect(h.listEnrollments()[0].status).toBe("unused");
    now += 1; expect(h.listEnrollments()[0].status).toBe("expired");
    expect(() => h.enroll(enrollInput(h, a.token))).toThrow(/expired/);
    let reason = (): unknown => { try { h.enroll(enrollInput(h, a.token)); } catch (error) { return (error as { reason?: unknown }).reason; } };
    expect(reason()).toBe("expired");
    const b = h.createEnrollment(ACTOR); h.revokeEnrollment(b.id, ACTOR);
    reason = (): unknown => { try { h.enroll(enrollInput(h, b.token)); } catch (error) { return (error as { reason?: unknown }).reason; } };
    expect(reason()).toBe("revoked");
    reason = (): unknown => { try { h.enroll(enrollInput(h, generateEnrollToken())); } catch (error) { return (error as { reason?: unknown }).reason; } };
    expect(reason()).toBe("invalid");
    expect(h.listMachines()).toEqual([]);
  });
  it("ends every earlier unused token when a new one is made, and only the new one works", () => {
    const h = hub(), first = h.createEnrollment(ACTOR), second = h.createEnrollment(ACTOR);
    expect(h.listEnrollments().map(row => [row.id, row.status])).toEqual([[second.id, "unused"], [first.id, "revoked"]]);
    expect(() => h.enroll(enrollInput(h, first.token))).toThrow(/revoked/);
    expect(h.enroll(enrollInput(h, second.token)).status).toBe("enrolled");
  });
  it("keeps a used token's status when a newer one is made (a used one is history, not something to revoke)", () => {
    const h = hub(), first = h.createEnrollment(ACTOR); h.enroll(enrollInput(h, first.token)); h.createEnrollment(ACTOR);
    expect(h.listEnrollments().find(row => row.id === first.id)?.status).toBe("used");
    expect(() => h.revokeEnrollment(first.id, ACTOR)).toThrow(/Only an unused/);
  });
  it("revokes an unused token and says so, and refuses to revoke what does not exist", () => {
    const h = hub(), { id, token } = h.createEnrollment(ACTOR);
    expect(h.revokeEnrollment(id, ACTOR)).toMatchObject({ id, status: "revoked" });
    expect(() => h.enroll(enrollInput(h, token))).toThrow(/revoked/);
    expect(() => h.revokeEnrollment("00000000-0000-4000-8000-000000000000", ACTOR)).toThrow(/not found/);
  });
  it("refuses a token for a different AgEnD: a fingerprint that is not this server's, even with the right token", () => {
    const h = hub(), { token } = h.createEnrollment(ACTOR);
    let refusal: unknown; try { h.enroll(enrollInput(h, token, { fingerprint: "0".repeat(64) })); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ reason: "mismatch" });
    expect(h.listEnrollments()[0].status).toBe("unused");                                                    // a wrong-server attempt spends nothing
    expect(h.enroll(enrollInput(h, token)).status).toBe("enrolled");
  });
  it("binds the token to the identity it was issued under: after the identity changes it no longer works", () => {
    const dir = home(), first = hub({}, dir), { token } = first.createEnrollment(ACTOR); first.close(); hubs.pop();
    rmSync(join(dir, ENROLL_IDENTITY_FILE));                                                                 // a different AgEnD identity under the same data folder
    const second = hub({}, dir);
    expect(second.serverFingerprint()).not.toBe(first.serverFingerprint());
    expect(() => second.enroll(enrollInput(second, token))).toThrow(/different AgEnD/);
  });
  it("survives a restart: what was used, revoked or still pending is what it was, and an unused token still works", () => {
    const dir = home(), first = hub({}, dir), a = first.createEnrollment(ACTOR), usedMachine = first.enroll(enrollInput(first, a.token)).machineId;
    const b = first.createEnrollment(ACTOR); first.revokeEnrollment(b.id, ACTOR); const c = first.createEnrollment(ACTOR);
    first.close(); hubs.pop();
    const second = hub({}, dir);
    expect(second.listEnrollments().map(row => [row.id, row.status])).toEqual([[c.id, "unused"], [b.id, "revoked"], [a.id, "used"]]);
    expect(second.machine(usedMachine)?.enrolledVia).toBe("install-command");
    expect(() => second.enroll(enrollInput(second, a.token))).toThrow(/already used/); expect(() => second.enroll(enrollInput(second, b.token))).toThrow(/revoked/);
    expect(second.enroll(enrollInput(second, c.token)).status).toBe("enrolled");
  });
  it("records issue, use and revoke (and a replaced token), with no token, hash or address in the record", () => {
    const seen: RuntimeEnrollmentAuditEntry[] = []; const h = hub({ audit: entry => seen.push(entry) });
    const a = h.createEnrollment(ACTOR), b = h.createEnrollment(ACTOR), used = h.enroll(enrollInput(h, b.token)), c = h.createEnrollment(ACTOR); h.revokeEnrollment(c.id, ACTOR);
    try { h.enroll(enrollInput(h, a.token)); } catch { /* refused: logged, not stored */ }
    expect(seen.map(entry => [entry.event, entry.enrollmentId, entry.actor, entry.machineId])).toEqual([
      ["issued", a.id, ACTOR, undefined], ["superseded", a.id, ACTOR, undefined], ["issued", b.id, ACTOR, undefined],
      ["used", b.id, undefined, used.machineId], ["issued", c.id, ACTOR, undefined], ["revoked", c.id, ACTOR, undefined], ["rejected", a.id, undefined, undefined]]);
    expect(seen.at(-1)).toMatchObject({ reason: "revoked" });
    const stored = JSON.parse(readFileSync(join(homes[0], "runtime-machines.json"), "utf8")).enrollmentAudit as Array<Record<string, unknown>>;
    expect(stored.map(entry => entry.event)).toEqual(["issued", "superseded", "issued", "used", "issued", "revoked", "rejected"]);   // a refusal on a known token is in the trail too
    const everything = JSON.stringify([seen, stored]);
    for (const token of [a.token, b.token, c.token]) { expect(everything).not.toContain(token); expect(everything).not.toContain(hashEnrollToken(token)); }
    expect(everything).not.toContain(used.credential);
  });
  it("keeps the audit trail bounded and never fails a use because the log hook failed", () => {
    const h = hub({ audit: () => { throw new Error("log hook down"); } });
    for (let i = 0; i < 40; i++) h.createEnrollment(ACTOR);
    expect(JSON.parse(readFileSync(join(homes[0], "runtime-machines.json"), "utf8")).enrollmentAudit.length).toBeLessThanOrEqual(512);
    expect(h.enroll(enrollInput(h, h.createEnrollment(ACTOR).token)).status).toBe("enrolled");
  });
  it("keeps the audit trail within its cap through issue, use AND revoke, and still starts after a restart", () => {
    const dir = home(), first = hub({}, dir);
    for (let i = 0; i < 300; i++) { const { id, token } = first.createEnrollment(ACTOR); if (i % 3 === 0) first.revokeEnrollment(id, ACTOR); else if (i % 3 === 1 && i < 60) first.enroll(enrollInput(first, token, { name: `PC ${i}` })); }
    const path = join(dir, "runtime-machines.json"), length = (): number => JSON.parse(readFileSync(path, "utf8")).enrollmentAudit.length;
    expect(length()).toBeLessThanOrEqual(512);
    // exactly full, then one more entry of each kind
    for (let guard = 0; length() < 512 && guard < 400; guard++) first.createEnrollment(ACTOR);
    const { id } = first.createEnrollment(ACTOR); first.revokeEnrollment(id, ACTOR); expect(length()).toBeLessThanOrEqual(512);
    first.close(); hubs.pop();
    expect(() => hub({}, dir)).not.toThrow();
    // a journal that already holds too many entries (an older build, or an edit) is cut to the newest, never refused
    const state = JSON.parse(readFileSync(path, "utf8")); state.enrollmentAudit.push(...state.enrollmentAudit.slice(0, 5)); writeFileSync(path, JSON.stringify(state));
    expect(() => hub({}, dir)).not.toThrow();
  });
  it("does not leave a half-made computer when the journal cannot be written", () => {
    const h = hub(), { token } = h.createEnrollment(ACTOR);
    const save = vi.spyOn(h as unknown as { save(): void }, "save").mockImplementation(() => { throw new Error("disk full"); });
    expect(() => h.enroll(enrollInput(h, token))).toThrow(/disk full/); save.mockRestore();
    expect(h.listMachines()).toEqual([]); expect(h.listEnrollments()[0].status).toBe("unused");
    expect(h.enroll(enrollInput(h, token)).status).toBe("enrolled");
  });
  it("validates the request closely: unknown fields, a malformed token or fingerprint, a bad name or platform", () => {
    const h = hub(), { token } = h.createEnrollment(ACTOR);
    for (const bad of [{ extra: 1 }, { nonce: "ab".repeat(16) }, { token: "agend_enroll_short" }, { fingerprint: "ZZ" }, { name: " " }, { name: "a\nb" }, { platform: "linux" }, { hostname: "x\ny" }])
      expect(() => h.enroll(enrollInput(h, token, bad))).toThrow(/Invalid runtime enrollment request/);
    expect(() => h.enroll("nope")).toThrow(/Invalid runtime enrollment request/);
    expect(h.listEnrollments()[0].status).toBe("unused");
  });
  it("respects the machine limit", () => {
    const h = hub();
    for (let i = 0; i < 64; i++) h.enroll(enrollInput(h, h.createEnrollment(ACTOR).token, { name: `PC ${i}` }));
    expect(() => h.enroll(enrollInput(h, h.createEnrollment(ACTOR).token))).toThrow(/limit/);
  });
  it("rejects a journal whose enrollment records are malformed", () => {
    const dir = home(); hub({}, dir).createEnrollment(ACTOR); hubs.pop()!.close();
    const path = join(dir, "runtime-machines.json"), state = JSON.parse(readFileSync(path, "utf8")); state.enrollments[0].tokenHash = "nope"; writeFileSync(path, JSON.stringify(state));
    expect(() => new RuntimeCoordinator(dir)).toThrow(/Malformed runtime machine store/);
  });
  it("lets the computer it created connect with its credential, and revoking that computer ends the connection", async () => {
    const h = hub(), base = await listen(h), { token } = h.createEnrollment(ACTOR), result = h.enroll(enrollInput(h, token));
    const ws = new WebSocket(base.replace("http:", "ws:") + "/runtime/v1/connect", { headers: { Authorization: `Bearer ${result.credential}` } }); clients.push(ws);
    await once(ws, "open"); const welcome = once(ws, "message");
    ws.send(JSON.stringify({ v: 1, type: "hello", bootId: "boot-1", inventory: { home: "C:\\Users\\test", clis: [] } })); await welcome;
    expect(h.machine(result.machineId)?.status).toBe("online");
    const closed = once(ws, "close"); h.revoke(result.machineId); const [code] = await closed; expect(code).toBe(1008);
    expect(h.machine(result.machineId)?.status).toBe("revoked");
  });
});

describe("the public routes", () => {
  const post = postJson;
  it("answers hello with the identity key, a fresh X25519 key and a signature that covers the nonce and that key; it spends nothing", async () => {
    const h = hub(), base = await listen(h), { token } = h.createEnrollment(ACTOR);
    const answer = await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: nonce(), tid: runtimeEnrollTokenId(token) });
    expect(answer.status).toBe(200);
    expect(verifyRuntimeServerProof(h.serverFingerprint(), answer.body.publicKey, answer.body.signature, runtimeEnrollHelloMessage(nonce(), String(answer.body.ephemeral)))).toBe(true);
    expect(h.listEnrollments()[0].status).toBe("unused");
    expect((await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: "short" })).status).toBe(400);
    expect((await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: nonce(), extra: 1 })).status).toBe(400);
    expect((await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: "cd".repeat(16), tid: "ZZ" })).status).toBe(400);
  });
  it("gives every hello its own fresh key (a key is never reused), and refuses a nonce that was already asked", async () => {
    const h = hub(), base = await listen(h), first = await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: nonce() }), second = await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: "cd".repeat(16) });
    expect(first.body.ephemeral).not.toBe(second.body.ephemeral);
    expect((await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: nonce() })).status).toBe(400);               // the same nonce again: not a second key for the same exchange
  });
  it("enrolls over HTTP with the request and the answer sealed, and then refuses the same token with a reason", async () => {
    const h = hub(), base = await listen(h), { token } = h.createEnrollment(ACTOR);
    const first = await sealedEnroll(base, enrollInput(h, token));
    expect(first.answer.status).toBe(201); expect(Object.keys(first.answer.body)).toEqual(["box"]);                // nothing in the clear but the box
    expect(first.opened).toMatchObject({ status: "enrolled" }); expect(String(first.opened!.credential)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first.answer.body)).not.toContain(String(first.opened!.credential)); expect(JSON.stringify(first.answer.body)).not.toContain(String(first.opened!.machineId));
    const second = await sealedEnroll(base, enrollInput(h, token));
    expect(second.answer.status).toBe(403); expect(second.answer.body).toMatchObject({ reason: "used" }); expect(JSON.stringify(second.answer.body)).not.toContain(token);
  });
  it("gives every refusal its status and reason, and an unknown token only the generic 'invalid'", async () => {
    let now = 1_000_000; const h = hub({ now: () => now }), base = await listen(h);
    const a = h.createEnrollment(ACTOR); now += ENROLL_TTL_MS;
    expect((await sealedEnroll(base, enrollInput(h, a.token))).answer).toMatchObject({ status: 403, body: { reason: "expired" } });
    const b = h.createEnrollment(ACTOR); h.revokeEnrollment(b.id, ACTOR);
    expect((await sealedEnroll(base, enrollInput(h, b.token))).answer).toMatchObject({ status: 403, body: { reason: "revoked" } });
    const c = h.createEnrollment(ACTOR);
    expect((await sealedEnroll(base, enrollInput(h, c.token, { fingerprint: "1".repeat(64) }))).answer).toMatchObject({ status: 403, body: { reason: "mismatch" } });
    expect((await sealedEnroll(base, enrollInput(h, generateEnrollToken()))).answer).toMatchObject({ status: 400, body: { reason: "invalid" } });
  });
  it("refuses a request that is not sealed to the key it was given: no hello first, a replay, a box from another exchange, a tampered box, a changed id", async () => {
    const h = hub(), base = await listen(h), { token } = h.createEnrollment(ACTOR), tid = runtimeEnrollTokenId(token);
    const mine = newRuntimeEnrollEphemeral();
    expect((await post(base, RUNTIME_ENROLL_PATH, { nonce: nonce(), tid, clientKey: mine.publicKey, iv: "A".repeat(16), ciphertext: "A".repeat(60) })).status).toBe(400);   // never said hello
    // a replay of a request that was accepted
    const key = newRuntimeEnrollEphemeral(), hello = await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: "cd".repeat(16), tid }), ephemeral = String(hello.body.ephemeral);
    const channel = runtimeEnrollChannel(key.privateKey, ephemeral, "cd".repeat(16), tid, ephemeral, key.publicKey), box = sealRuntimeEnroll(channel.requestKey, channel.context, "request", Buffer.from(JSON.stringify(enrollInput(h, token))));
    const request = { nonce: "cd".repeat(16), tid, clientKey: key.publicKey, ...box };
    expect((await post(base, RUNTIME_ENROLL_PATH, request)).status).toBe(201);
    expect((await post(base, RUNTIME_ENROLL_PATH, request)).status).toBe(400); expect(h.listMachines()).toHaveLength(1);
    // a tampered box, a box sealed for the other direction, a changed tid: each is refused and spends the session (and not the token)
    const t2 = h.createEnrollment(ACTOR), id2 = runtimeEnrollTokenId(t2.token);
    for (const tamper of ["flip", "direction", "tid"] as const) {
      const n = randomBytes(24).toString("hex"), hi = await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: n, tid: id2 }), eph = String(hi.body.ephemeral), mk = newRuntimeEnrollEphemeral();
      const ch = runtimeEnrollChannel(mk.privateKey, eph, n, id2, eph, mk.publicKey);
      let sealed = sealRuntimeEnroll(ch.requestKey, ch.context, tamper === "direction" ? "reply" : "request", Buffer.from(JSON.stringify(enrollInput(h, t2.token))));
      if (tamper === "flip") sealed = { ...sealed, ciphertext: (sealed.ciphertext[0] === "A" ? "B" : "A") + sealed.ciphertext.slice(1) };
      const answer = await post(base, RUNTIME_ENROLL_PATH, { nonce: n, tid: tamper === "tid" ? runtimeEnrollTokenId(token) : id2, clientKey: mk.publicKey, ...sealed });
      expect(answer.status, tamper).toBe(400);
    }
    expect(h.listEnrollments()[0]).toMatchObject({ id: t2.id, status: "unused" }); expect(h.listMachines()).toHaveLength(1);
  });
  it("refuses a request whose fresh key has aged out (two minutes) and drops old sessions", async () => {
    let now = 1_000_000; const h = hub({ now: () => now }), base = await listen(h), { token } = h.createEnrollment(ACTOR);
    const hello = await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: nonce() }); expect(hello.status).toBe(200);
    now += 2 * 60_000 + 1;
    const mine = newRuntimeEnrollEphemeral(), ephemeral = String(hello.body.ephemeral), channel = runtimeEnrollChannel(mine.privateKey, ephemeral, nonce(), "0".repeat(16), ephemeral, mine.publicKey);
    const box = sealRuntimeEnroll(channel.requestKey, channel.context, "request", Buffer.from(JSON.stringify(enrollInput(h, token))));
    expect((await post(base, RUNTIME_ENROLL_PATH, { nonce: nonce(), tid: "0".repeat(16), clientKey: mine.publicKey, ...box })).status).toBe(400);
    expect(h.listEnrollments()[0].status).toBe("unused");
  });
  it("is POST-only, takes no query, and refuses a browser (an Origin or a cookie)", async () => {
    const h = hub(), base = await listen(h), { token } = h.createEnrollment(ACTOR);
    expect((await fetch(base + RUNTIME_ENROLL_PATH)).status).toBe(403);
    expect((await fetch(base + RUNTIME_ENROLL_PATH + "?x=1", { method: "POST", body: "{}" })).status).toBe(403);
    expect((await fetch(base + RUNTIME_ENROLL_PATH, { method: "POST", headers: { Origin: "https://evil.example" }, body: JSON.stringify(enrollInput(h, token)) })).status).toBe(403);
    expect((await fetch(base + RUNTIME_ENROLL_HELLO_PATH, { method: "POST", headers: { Cookie: "a=b" }, body: JSON.stringify({ nonce: nonce() }) })).status).toBe(403);
    expect(h.listEnrollments()[0].status).toBe("unused");
  });
  it("keeps the identity check of a real token out of the shared address bucket: flooding the address does not lock a real installer out", async () => {
    const h = hub(), base = await listen(h), { token } = h.createEnrollment(ACTOR), tid = runtimeEnrollTokenId(token);
    // everyone behind one proxy address, and an id that names no token, share the address bucket (120 a minute); spend it
    let statuses: number[] = []; for (let i = 0; i < 125; i++) statuses.push((await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: randomBytes(24).toString("hex"), tid: "f".repeat(16) })).status);
    expect(statuses.slice(0, 120).every(status => status === 200)).toBe(true); expect(statuses.at(-1)).toBe(429);
    expect((await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: randomBytes(24).toString("hex") })).status).toBe(429);              // no id: the address bucket
    // a hello that names a real token has that token's own bucket: still answered, and its enroll works
    const real = await sealedEnroll(base, enrollInput(h, token));
    expect(real.hello.status).toBe(200); expect(real.answer.status).toBe(201);
    // that bucket is limited too (30 a minute), so one token cannot flood either
    statuses = []; for (let i = 0; i < 33; i++) statuses.push((await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: randomBytes(24).toString("hex"), tid })).status);
    expect(statuses.slice(0, 29).every(status => status === 200)).toBe(true); expect(statuses.at(-1)).toBe(429);
  });
  it("does the same for the enroll request: invalid traffic on the address bucket does not stop a real token's request", async () => {
    const h = hub(), base = await listen(h);
    for (let i = 0; i < 31; i++) await post(base, "/runtime/v1/pair", { code: "NOPE", name: "x", platform: "win32" });
    expect((await post(base, "/runtime/v1/pair", { code: "NOPE", name: "x", platform: "win32" })).status).toBe(429);       // the shared invalid bucket is spent
    const { token } = h.createEnrollment(ACTOR), real = await sealedEnroll(base, enrollInput(h, token));
    expect(real.answer.status).toBe(201);
  });
  it("rate-limits a token that keeps being refused", async () => {
    const h = hub(), base = await listen(h), { id, token } = h.createEnrollment(ACTOR); h.revokeEnrollment(id, ACTOR);
    const statuses: number[] = []; for (let i = 0; i < 40; i++) statuses.push((await sealedEnroll(base, enrollInput(h, token))).answer.status);
    // each attempt is a hello (the token's own bucket, 30 a minute) then an enroll (also 30 a minute): 30 refusals with a reason, then 429
    expect(statuses.filter(status => status === 403)).toHaveLength(30); expect(statuses.at(-1)).toBe(429);
  });
});

describe("the administrator routes", () => {
  const token = "t".repeat(48);
  function request(path: string, method = "GET", body: unknown = {}): IncomingMessage {
    const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
    req.method = method; req.url = path; req.headers = { host: "localhost", "x-agend-token": token };
    Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" }, configurable: true }); return req;
  }
  class Response extends ServerResponse {
    status = 0; body = "";
    override writeHead(code: number): this { this.status = code; return this; }
    override end(chunk?: unknown): this { this.body += String(chunk ?? ""); return this; }
  }
  beforeEach(() => vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"));
  afterEach(() => vi.unstubAllEnvs());
  function run(ctx: RuntimeApiContext, path: string, method = "GET", body: unknown = {}, mutate?: (req: IncomingMessage) => void) {
    const req = request(path, method, body), res = new Response(req); mutate?.(req);
    handleRuntimeRequest(req, res, new URL(path, "http://localhost"), ctx); return res;
  }
  /** #3327: an install-command token is made and revoked only by a local administrator SESSION (cookie and CSRF, never the bare header token), like a pairing code. */
  const asAdmin = (ctx: RuntimeApiContext) => {
    const store = new WebSessionStore(); (ctx as { webSessions?: WebSessionStore }).webSessions = store;
    const { sessionId, record } = store.create({ tier: "admin", surface: "local", label: "test", tokenEpoch: tokenEpoch(token) });
    return { handle: record.handle, as: (req: IncomingMessage): void => { delete req.headers["x-agend-token"]; req.headers.cookie = `${WEB_SESSION_COOKIE}=${sessionId}`; req.headers.origin = "http://localhost"; req.headers["x-agend-csrf"] = csrfTokenFor(sessionId); } };
  };
  const context = () => { const h = hub(), ctx: RuntimeApiContext = { webToken: token, runtimeCoordinator: () => h }; return { h, ctx, ...asAdmin(ctx) }; };
  it("issues a token to an authorised administrator, once, with the server fingerprint, and lists it to that administrator without the token", async () => {
    const { h, ctx, as } = context(), issued = run(ctx, "/ui/runtimes/enrollment", "POST", {}, as);
    await vi.waitFor(() => expect(issued.status).toBe(201));
    const body = JSON.parse(issued.body); expect(body.token).toMatch(RUNTIME_ENROLL_TOKEN_PATTERN); expect(body.fingerprint).toBe(h.serverFingerprint());
    expect(JSON.parse(run(ctx, "/ui/runtimes").body).enrollments, "the header token is shown none").toEqual([]);
    const list = run(ctx, "/ui/runtimes", "GET", {}, as); expect(list.status).toBe(200);
    expect(list.body).not.toContain(body.token); expect(JSON.parse(list.body).enrollments).toEqual([{ id: body.id, status: "unused", createdAt: body.createdAt, expiresAt: body.expiresAt }]);
  });
  it("needs the same authorization as a pairing code: the bare header token, no credential or a foreign Origin gets nothing", async () => {
    const { h, ctx, as } = context(), create = vi.spyOn(h, "createEnrollment");
    for (const kind of ["header-token", "missing", "origin"]) {
      const res = run(ctx, "/ui/runtimes/enrollment", "POST", {}, req => { if (kind === "missing") delete req.headers["x-agend-token"]; else if (kind === "origin") { as(req); req.headers.origin = "https://foreign.example"; } });
      expect(res.status, kind).toBe(403); expect(res.body, kind).not.toMatch(/agend_enroll_/);
    }
    expect(create).not.toHaveBeenCalled();
  });
  it("answers 404 for those routes while Remote Runtime is off, and 404 for a GET", async () => {
    vi.stubEnv("AGEND_REMOTE_RUNTIME", ""); const get = vi.fn();
    expect(run({ webToken: token, runtimeCoordinator: get }, "/ui/runtimes/enrollment", "POST").status).toBe(404); expect(get).not.toHaveBeenCalled();
    vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"); const { ctx } = context();
    expect(run(ctx, "/ui/runtimes/enrollment", "GET").status).toBe(404);
  });
  it("revokes an unused token, and refuses fields or an unknown id", async () => {
    const { h, ctx, as } = context(), { id, token: secret } = h.createEnrollment(ACTOR);
    expect(run(ctx, `/ui/runtimes/enrollment/${id}/revoke`, "POST").status).toBe(403);   // the header token cannot revoke either
    const ok = run(ctx, `/ui/runtimes/enrollment/${id}/revoke`, "POST", {}, as); await vi.waitFor(() => expect(ok.status).toBe(200));
    expect(JSON.parse(ok.body).enrollment).toMatchObject({ id, status: "revoked" }); expect(() => h.enroll(enrollInput(h, secret))).toThrow(/revoked/);
    const bad = run(ctx, `/ui/runtimes/enrollment/${id}/revoke`, "POST", { x: 1 }, as); await vi.waitFor(() => expect(bad.status).toBe(400));
    const missing = run(ctx, "/ui/runtimes/enrollment/00000000-0000-4000-8000-000000000000/revoke", "POST", {}, as); await vi.waitFor(() => expect(missing.status).toBe(400));
    const fields = run(ctx, "/ui/runtimes/enrollment", "POST", { server: "x" }, as); await vi.waitFor(() => expect(fields.status).toBe(400));
  });
  it("records the administrator session handle as the actor (an opaque value, never an address)", async () => {
    const seen: RuntimeEnrollmentAuditEntry[] = [], h = hub({ audit: entry => seen.push(entry) }), ctx: RuntimeApiContext = { webToken: token, runtimeCoordinator: () => h }, { handle, as } = asAdmin(ctx);
    const res = run(ctx, "/ui/runtimes/enrollment", "POST", {}, as); await vi.waitFor(() => expect(res.status).toBe(201));
    expect(seen[0]).toMatchObject({ event: "issued", actor: `admin:${handle}` }); expect(handle).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("the Runtime joining with a token (enrollRuntime)", () => {
  // The Runtime reports the platform it runs on, and AgEnD accepts only Windows ones.
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => { Object.defineProperty(process, "platform", { value: "win32" }); });
  afterEach(() => { Object.defineProperty(process, "platform", platform); });
  const storeDir = (): RuntimeClientStore => { const dir = mkdtempSync(join(tmpdir(), "agend-runtime-enroll-profile-")); homes.push(dir); return new RuntimeClientStore(dir); };
  it("proves the server first, then spends the token, and saves a credential the server accepts", async () => {
    const log: string[] = [], h = hub(), base = await listen(h, log), { token } = h.createEnrollment(ACTOR), store = storeDir(), reports: string[] = [];
    const credentials = await enrollRuntime({ server: base, token, fingerprint: h.serverFingerprint(), name: "Desk", store, report: text => reports.push(text) });
    expect(log).toEqual([`POST ${RUNTIME_ENROLL_HELLO_PATH}`, `POST ${RUNTIME_ENROLL_PATH}`]);               // identity before token, in that order
    expect(store.credentials()).toMatchObject({ server: base, machineId: credentials.machineId, credential: credentials.credential, name: "Desk" });
    expect(h.machine(credentials.machineId)).toMatchObject({ enrolledVia: "install-command", status: "offline" });
    expect(reports.join("\n")).not.toContain(token);
    const ws = new WebSocket(base.replace("http:", "ws:") + "/runtime/v1/connect", { headers: { Authorization: `Bearer ${credentials.credential}` } }); clients.push(ws);
    await once(ws, "open");
  });
  it("sends NOTHING secret when the server's fingerprint is not the pinned one: the token is never transmitted", async () => {
    const log: string[] = [], bodies: string[] = [], h = hub(), real = createServer((req, res) => {
      const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => { log.push(`${req.method} ${req.url}`); bodies.push(Buffer.concat(chunks).toString()); if (!h.handlePublicRequest(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); } });
    });
    servers.push(real); real.listen(0, "127.0.0.1"); await once(real, "listening"); const base = `http://127.0.0.1:${(real.address() as { port: number }).port}`;
    const { token } = h.createEnrollment(ACTOR), store = storeDir();
    await expect(enrollRuntime({ server: base, token, fingerprint: "e".repeat(64), name: "Desk", store })).rejects.toThrow(/did not prove it is the AgEnD this install command was made for.*NOT sent/s);
    expect(log).toEqual([`POST ${RUNTIME_ENROLL_HELLO_PATH}`]); expect(bodies.join("")).not.toContain(token);
    expect(store.credentials()).toBeNull(); expect(h.listEnrollments()[0].status).toBe("unused"); expect(h.listMachines()).toEqual([]);
  });
  it("sends nothing secret to something that is not an AgEnD at all (no JSON, or the route is missing)", async () => {
    const seenBodies: string[] = [], other = createServer((req, res) => { req.on("data", chunk => seenBodies.push(String(chunk))); req.on("end", () => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html>hello</html>"); }); });
    servers.push(other); other.listen(0, "127.0.0.1"); await once(other, "listening"); const base = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
    const token = generateEnrollToken();
    await expect(enrollRuntime({ server: base, token, fingerprint: "a".repeat(64), name: "Desk", store: storeDir() })).rejects.toThrow(/NOT sent/);
    expect(seenBodies.join("")).not.toContain(token);
  });
  it("refuses an answer that was not sealed under this exchange's key (a forged or swapped grant), and saves nothing", async () => {
    const h = hub(), identity = loadRuntimeServerIdentity(homes[0]);
    const proxy = createServer((req, res) => {
      const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (req.url === RUNTIME_ENROLL_HELLO_PATH) {                                // a properly signed hello (this stands in for the real server)
          const mine = newRuntimeEnrollEphemeral(); res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ publicKey: identity.publicKey, ephemeral: mine.publicKey, signature: identity.signature(runtimeEnrollHelloMessage(body.nonce, mine.publicKey)) })); return;
        }
        // an answer sealed under some other key: what anyone who cannot do the key agreement can send
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ box: sealRuntimeEnroll(randomBytes(32), "whatever", "reply", Buffer.from(JSON.stringify({ status: "enrolled", machineId: "11111111-2222-4333-8444-555555555555", credential: "c".repeat(64) }))) }));
      });
    });
    servers.push(proxy); proxy.listen(0, "127.0.0.1"); await once(proxy, "listening"); const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, store = storeDir();
    await expect(enrollRuntime({ server: base, token: generateEnrollToken(), fingerprint: identity.fingerprint, name: "Desk", store })).rejects.toThrow(/could not be verified, so nothing was saved/);
    expect(store.credentials()).toBeNull(); expect(h).toBeTruthy();
  });
  describe("a relay between the Runtime and the real server (a server that took over the address, with a valid certificate)", () => {
    /** The relay forwards every request to the real server and keeps a copy of everything that passes through it, both ways. */
    async function relay(real: string, tamper?: (url: string, body: Record<string, unknown>, answer: { status: number; body: Record<string, unknown> }) => void) {
      const seen = { requests: [] as string[], answers: [] as string[] };
      const server = createServer((req, res) => {
        const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => {
          const raw = Buffer.concat(chunks).toString(); seen.requests.push(`${req.url} ${raw}`);
          void fetch(real + req.url, { method: req.method, headers: { "Content-Type": "application/json" }, body: raw }).then(async forwarded => {
            const answer = { status: forwarded.status, body: await forwarded.json() as Record<string, unknown> };
            tamper?.(req.url ?? "", JSON.parse(raw), answer);
            const text = JSON.stringify(answer.body); seen.answers.push(`${req.url} ${text}`);
            res.writeHead(answer.status, { "Content-Type": "application/json" }); res.end(text);
          });
        });
      });
      servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
      return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
    }
    it("reads neither the token nor the credential: a relay that forwards the identity check to the real server gets a valid proof and still cannot read what follows", async () => {
      const h = hub(), real = await listen(h), { token } = h.createEnrollment(ACTOR), { base, seen } = await relay(real), store = storeDir();
      const credentials = await enrollRuntime({ server: base, token, fingerprint: h.serverFingerprint(), name: "Desk", store });   // it completes: a faithful relay cannot stop it, only watch it
      const requests = seen.requests.join("\n"), answers = seen.answers.join("\n");
      // what the relay captured: the token and the credential are NOT in it, in any encoding it could try
      for (const needle of [token, token.slice("agend_enroll_".length), Buffer.from(token).toString("base64"), Buffer.from(token).toString("hex"), credentials.credential, Buffer.from(credentials.credential).toString("base64"), credentials.machineId]) {
        expect(requests).not.toContain(needle); expect(answers).not.toContain(needle);
      }
      const captured = requests.includes(token) || answers.includes(credentials.credential);
      expect(captured).toBe(false);                                                // the reviewer's scenario: before the fix this was true
      expect(requests).not.toMatch(/Desk/);                                        // not even the computer's name or hostname
      expect(store.credentials()?.credential).toBe(credentials.credential);
    });
    it("cannot replay what it captured: the accepted request, sent again, is refused and adds no computer", async () => {
      const h = hub(), real = await listen(h), { token } = h.createEnrollment(ACTOR), { base, seen } = await relay(real);
      await enrollRuntime({ server: base, token, fingerprint: h.serverFingerprint(), name: "Desk", store: storeDir() });
      const captured = seen.requests.find(entry => entry.startsWith(`${RUNTIME_ENROLL_PATH} `))!.slice(RUNTIME_ENROLL_PATH.length + 1);
      const replay = await postJson(real, RUNTIME_ENROLL_PATH, JSON.parse(captured));
      expect(replay.status).toBe(400); expect(h.listMachines()).toHaveLength(1);
    });
    it("cannot swap in a key of its own: a hello whose fresh key was replaced fails the signature, so the Runtime stops and the token is never sent", async () => {
      const h = hub(), real = await listen(h), { token } = h.createEnrollment(ACTOR);
      const { base, seen } = await relay(real, (url, _body, answer) => { if (url === RUNTIME_ENROLL_HELLO_PATH) answer.body.ephemeral = newRuntimeEnrollEphemeral().publicKey; });
      await expect(enrollRuntime({ server: base, token, fingerprint: h.serverFingerprint(), name: "Desk", store: storeDir() })).rejects.toThrow(/did not prove.*NOT sent/s);
      expect(seen.requests.filter(entry => entry.startsWith(`${RUNTIME_ENROLL_PATH} `))).toEqual([]); expect(seen.requests.join("")).not.toContain(token);
      expect(h.listEnrollments()[0].status).toBe("unused");
    });
    it("cannot read or alter the answer either: a flipped byte in the sealed answer is refused, and nothing is saved", async () => {
      const h = hub(), real = await listen(h), { token } = h.createEnrollment(ACTOR), store = storeDir();
      const { base } = await relay(real, (url, _body, answer) => { if (url === RUNTIME_ENROLL_PATH) { const box = answer.body.box as { ciphertext: string }; box.ciphertext = (box.ciphertext[0] === "A" ? "B" : "A") + box.ciphertext.slice(1); } });
      await expect(enrollRuntime({ server: base, token, fingerprint: h.serverFingerprint(), name: "Desk", store })).rejects.toThrow(/could not be verified, so nothing was saved/);
      expect(store.credentials()).toBeNull();
    });
  });
  it("turns each refusal into one plain sentence that names the next step (open Settings, generate again), without the token", async () => {
    let now = 1_000_000; const h = hub({ now: () => now }), base = await listen(h), fingerprint = h.serverFingerprint(), store = storeDir();
    const expired = h.createEnrollment(ACTOR); now += ENROLL_TTL_MS;
    await expect(enrollRuntime({ server: base, token: expired.token, fingerprint, name: "Desk", store })).rejects.toThrow(/expired.*generate a new install command/s);
    const revoked = h.createEnrollment(ACTOR); h.revokeEnrollment(revoked.id, ACTOR);
    await expect(enrollRuntime({ server: base, token: revoked.token, fingerprint, name: "Desk", store })).rejects.toThrow(/revoked in AgEnD.*generate a new install command/s);
    const live = h.createEnrollment(ACTOR); await enrollRuntime({ server: base, token: live.token, fingerprint, name: "Desk", store: storeDir() });
    let used: Error | undefined; try { await enrollRuntime({ server: base, token: live.token, fingerprint, name: "Desk", store }); } catch (error) { used = error as Error; }
    expect(used?.message).toMatch(/already used.*generate a new install command/s); expect(used?.message).not.toContain(live.token);
    await expect(enrollRuntime({ server: base, token: generateEnrollToken(), fingerprint, name: "Desk", store })).rejects.toThrow(/not valid for this AgEnD.*generate a new install command/s);
    expect(store.credentials()).toBeNull();
    for (const reason of ["invalid", "expired", "used", "revoked", "mismatch", "limit", "anything-else"]) expect(describeEnrollRefusal(reason)).not.toBe("");
  });
  it("says so, and still sends no token, when AgEnD answers the identity request with 'too many requests'", async () => {
    const seenBodies: string[] = [], busy = createServer((req, res) => { req.on("data", chunk => seenBodies.push(String(chunk))); req.on("end", () => { res.writeHead(429, { "Content-Type": "application/json" }); res.end("{\"error\":\"Too many runtime pairing requests\"}"); }); });
    servers.push(busy); busy.listen(0, "127.0.0.1"); await once(busy, "listening"); const base = `http://127.0.0.1:${(busy.address() as { port: number }).port}`, token = generateEnrollToken();
    await expect(enrollRuntime({ server: base, token, fingerprint: "a".repeat(64), name: "Desk", store: storeDir() })).rejects.toThrow(/too many requests.*NOT sent/s);
    expect(seenBodies.join("")).not.toContain(token);
  });
  it("refuses a malformed token or fingerprint before it talks to anyone", async () => {
    const store = storeDir(), fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(enrollRuntime({ server: "http://127.0.0.1:1", token: "agend_enroll_short", fingerprint: "a".repeat(64), name: "Desk", store })).rejects.toThrow(/not valid/);
    await expect(enrollRuntime({ server: "http://127.0.0.1:1", token: generateEnrollToken(), fingerprint: "xyz", name: "Desk", store })).rejects.toThrow(/fingerprint/);
    expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore();
  });
  it("leaves the token in no file: not in the AgEnD data folder, not in the Runtime profile", async () => {
    const h = hub(), base = await listen(h), { token } = h.createEnrollment(ACTOR), store = storeDir();
    await enrollRuntime({ server: base, token, fingerprint: h.serverFingerprint(), name: "Desk", store });
    for (const dir of [homes[0], store.directory]) for (const text of everyFile(dir)) { expect(text).not.toContain(token); expect(text).not.toContain(token.slice("agend_enroll_".length)); }
    expect(existsSync(join(store.directory, "connection.json"))).toBe(true);
    // the credential file holds the machine credential and the address only
    expect(Object.keys(JSON.parse(readFileSync(join(store.directory, "connection.json"), "utf8"))).sort()).toEqual(["credential", "machineId", "name", "server"]);
    expect(createHash("sha256").update(token).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("the audit trail: refusals, where requests came from, throttling", () => {
  const trail = (dir: string): Array<Record<string, unknown>> => JSON.parse(readFileSync(join(dir, "runtime-machines.json"), "utf8")).enrollmentAudit;
  it("keeps a refusal on a known token in the persisted trail, with its reason", () => {
    const dir = home(), h = hub({}, dir), used = h.createEnrollment(ACTOR); h.enroll(enrollInput(h, used.token));
    expect(() => h.enroll(enrollInput(h, used.token))).toThrow(/already used/);
    const revoked = h.createEnrollment(ACTOR); h.revokeEnrollment(revoked.id, ACTOR); expect(() => h.enroll(enrollInput(h, revoked.token))).toThrow(/revoked/);
    expect(() => h.enroll(enrollInput(h, h.createEnrollment(ACTOR).token, { fingerprint: "9".repeat(64) }))).toThrow(/different AgEnD/);
    expect(trail(dir).filter(entry => entry.event === "rejected").map(entry => [String(entry.enrollmentId).slice(0, 8), entry.reason])).toEqual([[used.id.slice(0, 8), "used"], [revoked.id.slice(0, 8), "revoked"], [expect.any(String), "mismatch"]]);
  });
  it("does not record an unknown token one by one: fifty guesses add nothing to the trail", () => {
    const dir = home(), h = hub({}, dir); h.createEnrollment(ACTOR); const before = trail(dir).length;
    for (let i = 0; i < 50; i++) expect(() => h.enroll(enrollInput(h, generateEnrollToken()))).toThrow(/not valid/);
    expect(trail(dir)).toHaveLength(before);
  });
  it("stores where a use or a refusal came from only masked, and nothing for loopback", () => {
    const dir = home(), h = hub({}, dir);
    expect(maskedSource("203.0.113.77")).toBe("203.0.x.x"); expect(maskedSource("::ffff:198.51.100.9")).toBe("198.51.x.x"); expect(maskedSource("2001:db8:abcd:12::1")).toBe("2001:db8:x:x");
    for (const quiet of [undefined, "", "127.0.0.1", "::1", "::ffff:127.0.0.1", "garbage", "::", "1:2:3:4:5:6:7:8:9", "1::2::3", "fe80::g"]) expect(maskedSource(quiet), String(quiet)).toBeUndefined();
    // Shorthand (`::`) is written out before two groups are kept, so a group of the host part never survives: the second group is the one the `::` hides.
    expect(maskedSource("fe80::abcd:1")).toBe("fe80:0:x:x"); expect(maskedSource("2001:db8::1")).toBe("2001:db8:x:x"); expect(maskedSource("fe80::")).toBe("fe80:0:x:x");
    expect(maskedSource("fd7a:115c:a1e0:ab12:4843:cd96:6200:1")).toBe("fd7a:115c:x:x"); expect(maskedSource("FD7A:115C::1%eth0")).toBe("fd7a:115c:x:x"); expect(maskedSource("1::")).toBe("1:0:x:x");
    for (const address of ["fe80::abcd:1", "fe80::1:2:3:4:5", "2001:db8:1:2:3:4:5:6", "::2"]) { const masked = maskedSource(address)!; expect(masked, address).toMatch(/^[0-9a-f]{1,4}:[0-9a-f]{1,4}:x:x$/); expect(masked.includes("abcd") || masked.endsWith(":1:x:x")).toBe(false); }
    const a = h.createEnrollment(ACTOR); h.enroll(enrollInput(h, a.token), { remote: "203.0.113.77" });
    expect(() => h.enroll(enrollInput(h, a.token), { remote: "2001:db8:abcd:12::1" })).toThrow(/already used/);
    const b = h.createEnrollment(ACTOR); h.enroll(enrollInput(h, b.token), { remote: "127.0.0.1" });
    const entries = trail(dir);
    expect(entries.filter(entry => entry.event === "used").map(entry => entry.source)).toEqual(["203.0.x.x", undefined]);
    expect(entries.find(entry => entry.event === "rejected")?.source).toBe("2001:db8:x:x");
    expect(JSON.stringify(entries)).not.toMatch(/203\.0\.113|198\.51\.100|abcd:12|::1/);                        // a full address is never kept
  });
  it("writes one throttling summary a minute when an enrollment bucket starts refusing, however many requests follow", async () => {
    let now = 1_000_000; const dir = home(), h = hub({ now: () => now }, dir), base = await listen(h);
    for (let i = 0; i < 80; i++) await postJson(base, RUNTIME_ENROLL_PATH, { nonce: randomBytes(24).toString("hex"), tid: "f".repeat(16), clientKey: newRuntimeEnrollEphemeral().publicKey, iv: "A".repeat(16), ciphertext: "A".repeat(40) });
    expect(trail(dir).filter(entry => entry.event === "throttled")).toEqual([{ at: now, event: "throttled", scope: "enroll" }]);   // 30 answered "invalid", 50 throttled, one entry (loopback: no source)
    now += 61_000;
    await postJson(base, RUNTIME_ENROLL_PATH, { nonce: randomBytes(24).toString("hex"), tid: "f".repeat(16), clientKey: newRuntimeEnrollEphemeral().publicKey, iv: "A".repeat(16), ciphertext: "A".repeat(40) });   // the window moved on: a new window, a new bucket
    for (let i = 0; i < 30; i++) await postJson(base, RUNTIME_ENROLL_PATH, { nonce: randomBytes(24).toString("hex"), tid: "f".repeat(16), clientKey: newRuntimeEnrollEphemeral().publicKey, iv: "A".repeat(16), ciphertext: "A".repeat(40) });
    expect(trail(dir).filter(entry => entry.event === "throttled")).toHaveLength(2);
    const log = JSON.stringify(trail(dir)); expect(log).not.toContain("ffffffff");
  });
  it("reports hello flooding the same way, and the persisted trail still loads after a restart", async () => {
    const dir = home(), h = hub({}, dir), base = await listen(h);
    for (let i = 0; i < 125; i++) await postJson(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: randomBytes(24).toString("hex") });
    expect(trail(dir).filter(entry => entry.event === "throttled")).toEqual([expect.objectContaining({ scope: "hello" })]);
    h.close(); hubs.pop(); expect(() => hub({}, dir)).not.toThrow();
  });
  it("hands every entry, including a refusal and a throttling, to the log hook", async () => {
    const seen: RuntimeEnrollmentAuditEntry[] = [], h = hub({ audit: entry => seen.push(entry) }), { token } = h.createEnrollment(ACTOR);
    h.enroll(enrollInput(h, token)); expect(() => h.enroll(enrollInput(h, token))).toThrow();
    expect(seen.map(entry => entry.event)).toEqual(["issued", "used", "rejected"]);
  });
});

describe("a token cannot be spent twice at once, and only an administrator makes one", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => { Object.defineProperty(process, "platform", { value: "win32" }); });
  afterEach(() => { Object.defineProperty(process, "platform", platform); });
  it("lets exactly one of 25 concurrent HTTP requests with the same token succeed", async () => {
    const h = hub(), base = await listen(h), { token } = h.createEnrollment(ACTOR);
    const results = await Promise.all(Array.from({ length: 25 }, () => sealedEnroll(base, enrollInput(h, token, { name: "Racer" }))));
    const statuses = results.map(result => result.answer.status).sort();
    expect(statuses.filter(status => status === 201)).toHaveLength(1); expect(statuses.filter(status => status === 403)).toHaveLength(24);
    expect(results.filter(result => result.answer.status === 403).every(result => (result.answer.body as { reason?: string }).reason === "used")).toBe(true);
    expect(h.listMachines()).toHaveLength(1); expect(h.listEnrollments()[0].status).toBe("used");
  });
  it("lets exactly one of 25 concurrent clients win, through the real enrollRuntime", async () => {
    const h = hub(), base = await listen(h), { token } = h.createEnrollment(ACTOR);
    const stores = Array.from({ length: 25 }, () => { const dir = mkdtempSync(join(tmpdir(), "agend-runtime-enroll-race-")); homes.push(dir); return new RuntimeClientStore(dir); });
    const outcomes = await Promise.allSettled(stores.map(store => enrollRuntime({ server: base, token, fingerprint: h.serverFingerprint(), name: "Racer", store })));
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected").every(outcome => /already used/.test(String((outcome as PromiseRejectedResult).reason?.message)))).toBe(true);
    expect(stores.filter(store => store.credentials() !== null)).toHaveLength(1); expect(h.listMachines()).toHaveLength(1);
  });
});

describe("the owner is told when a computer joins with a token", () => {
  it("names the computer, its host, the token id and how to revoke it, and nothing else of the token", () => {
    const h = hub(), seen: RuntimeEnrollmentAuditEntry[] = [], watched = hub({ audit: entry => seen.push(entry) }), issued = watched.createEnrollment(ACTOR);
    const granted = watched.enroll(enrollInput(watched, issued.token, { name: "Desk-01", hostname: "DESK-01.corp" })), used = seen.find(entry => entry.event === "used")!;
    const text = enrolledRuntimeNotice(used, watched.machine(granted.machineId))!;
    expect(text).toContain('"Desk-01"'); expect(text).toContain('"DESK-01\u00b7corp"'); expect(text).toContain(issued.id.slice(0, 8)); expect(text).toContain(granted.machineId.slice(0, 8));
    expect(text).toMatch(/Settings → Runtime → the computer named above → Revoke connection/); expect(text).toMatch(/no approval step/); expect(text).not.toContain(issued.token); expect(text).not.toContain(granted.credential);
    expect(h).toBeTruthy();
  });
  it("says nothing for any other event, or for a computer that is gone", () => {
    const h = hub(), seen: RuntimeEnrollmentAuditEntry[] = [], watched = hub({ audit: entry => seen.push(entry) }), issued = watched.createEnrollment(ACTOR);
    expect(seen.map(entry => enrolledRuntimeNotice(entry, { name: "x", hostname: "y" }))).toEqual([null]);                      // "issued"
    const granted = watched.enroll(enrollInput(watched, issued.token)); expect(enrolledRuntimeNotice(seen.at(-1)!, null)).toBeNull(); expect(granted.machineId).toBeTruthy(); expect(h).toBeTruthy();
  });
  it("cuts a computer's own words to plain characters, so a leaked command cannot put a mention, a link or markup in the owner's chat", () => {
    const entry: RuntimeEnrollmentAuditEntry = { at: 1, event: "used", enrollmentId: "11111111-2222-4333-8444-555555555555", machineId: "99999999-2222-4333-8444-555555555555" };
    const text = enrolledRuntimeNotice(entry, { name: "@everyone [click](https://evil.example/x) `rm -rf`", hostname: "<b>host</b>\nNEW LINE ".repeat(10) })!;
    expect(text).not.toMatch(/@|https?:|\[|\]|`|<|>|\n.*NEW LINE/); expect(text.split("\n")).toHaveLength(1);
    expect(enrolledRuntimeNotice(entry, { name: "", hostname: undefined })).toContain('"?"');
  });
  it("shows a computer's own words in quotation marks and never leaves a dot a chat application would turn into a link", () => {
    const entry: RuntimeEnrollmentAuditEntry = { at: 1, event: "used", enrollmentId: "11111111-2222-4333-8444-555555555555", machineId: "99999999-2222-4333-8444-555555555555" };
    const domain = enrolledRuntimeNotice(entry, { name: "www.evil.com", hostname: "www.evil.com" })!;
    expect(domain).not.toMatch(/\w\.\w/); expect(domain).toContain('"www\u00b7evil\u00b7com" (host "www\u00b7evil\u00b7com",');
    // A name that tries to finish the sentence and give its own instruction stays one quoted piece of data: the quotation mark itself cannot be typed in.
    const forged = enrolledRuntimeNotice(entry, { name: 'x" FAKE: revoke at evil.test "', hostname: "h" })!;
    expect(forged).toContain('"x? FAKE? revoke at evil\u00b7test ?"'); expect(forged.match(/"/g)).toHaveLength(4);
  });
  it("is wired into the fleet: a `used` entry reaches the fleet's notice dispatch, and a failure there never changes the join, and the notice is kept until a delivery is acknowledged", () => {
    const source = readFileSync("src/fleet-manager.ts", "utf8");
    expect(source).toMatch(/if\(entry\.event==="used"\)try\{[\s\S]{0,400}enrolledRuntimeNotice\(entry,[\s\S]{0,400}if\(text\)this\.deliverOwnerNotice\(text\)[\s\S]{0,200}catch\(error\)/);
  });
});

// This suite models an admitted NTFS boundary; dedicated privacy tests retain the real gate and refusal ordering.
vi.mock("../src/runtime-pane-private.js", async original => ({ ...await original<typeof import("../src/runtime-pane-private.js")>(), protectRuntimeProfileDirectorySync(directory: string) {
  const fs = fixturePrivacyFs;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Unsafe profile fixture");
} }));
