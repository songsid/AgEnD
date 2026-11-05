/**
 * Fixtures for the Hub init tests (S-48): throwaway certificates made with openssl at test time (no keys in the repo),
 * a fake S1 identity provider that really signs, a fake directory and a scripted terminal.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirectoryPerson, HubDirectory, HubDirectoryDiagnostic, SignInResult } from "../../src/hub/directory/index.js";
import type { HubIdentityProvider, HubIdentitySummary } from "../../src/hub/init/types.js";
import type { WizardIO } from "../../src/hub/init/prompt.js";

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface TestCerts {
  dir: string;
  caCert: string;
  cert: string; // CA-signed, SAN hub.example.test + 192.0.2.10
  key: string;
  otherKey: string; // a key that does not match `cert`
  selfSigned: string; // self-signed for hub.example.test
  selfSignedKey: string;
  wrongHost: string; // CA-signed for other.example.test
  wrongHostKey: string;
}

function openssl(args: string[], cwd: string): void {
  execFileSync("openssl", args, { cwd, stdio: "ignore" });
}

export function makeTestCerts(): TestCerts {
  const dir = tempDir("agend-hubinit-certs-");
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  openssl(["req", "-x509", ...ec, "-days", "2", "-subj", "/CN=Test CA", "-keyout", "ca.key", "-out", "ca.pem"], dir);
  const leaf = (name: string, san: string) => {
    openssl(["req", ...ec, "-subj", `/CN=${name}`, "-keyout", `${name}.key`, "-out", `${name}.csr`], dir);
    writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n`);
    openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", `${name}.ext`, "-out", `${name}.pem`], dir);
  };
  leaf("hub", "DNS:hub.example.test,IP:192.0.2.10");
  leaf("other", "DNS:other.example.test");
  openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", "stray.key"], dir);
  openssl(["req", "-x509", ...ec, "-days", "2", "-subj", "/CN=hub.example.test", "-addext", "subjectAltName=DNS:hub.example.test", "-keyout", "self.key", "-out", "self.pem"], dir);
  const chain = `${readFileSync(join(dir, "hub.pem"), "utf8")}${readFileSync(join(dir, "ca.pem"), "utf8")}`;
  writeFileSync(join(dir, "hub-chain.pem"), chain);
  return {
    dir,
    caCert: join(dir, "ca.pem"),
    cert: join(dir, "hub-chain.pem"),
    key: join(dir, "hub.key"),
    otherKey: join(dir, "stray.key"),
    selfSigned: join(dir, "self.pem"),
    selfSignedKey: join(dir, "self.key"),
    wrongHost: join(dir, "other.pem"),
    wrongHostKey: join(dir, "other.key"),
  };
}

/** A stand-in for S1's provisionHubIdentity / read helper / sealHubInitialization, with the agreed shapes. */
export class FakeIdentity implements HubIdentityProvider {
  readonly available = true;
  provisions = 0;
  readonly issuer = generateKeyPairSync("ed25519");

  async provision(args: { home: string; memberOrigin: string }): Promise<HubIdentitySummary> {
    const keys = join(args.home, "hub", "keys");
    if (existsSync(join(keys, "identity.json"))) throw new Error("identity exists");
    mkdirSync(keys, { recursive: true, mode: 0o700 });
    this.provisions += 1;
    const tls = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const summary: HubIdentitySummary = {
      hubId: randomUUID(),
      spkiSha256: createHash("sha256").update(tls.publicKey.export({ type: "spki", format: "der" })).digest("hex"),
      issuerKeyId: randomBytes(8).toString("hex"),
      issuerPublicKey: this.issuer.publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    writeFileSync(join(keys, "identity.json"), JSON.stringify({ ...summary, memberOrigin: args.memberOrigin }), { mode: 0o600 });
    return summary;
  }

  async read(home: string): Promise<HubIdentitySummary | undefined> {
    const file = join(home, "hub", "keys", "identity.json");
    if (!existsSync(file)) return undefined;
    const { hubId, spkiSha256, issuerKeyId, issuerPublicKey } = JSON.parse(readFileSync(file, "utf8"));
    return { hubId, spkiSha256, issuerKeyId, issuerPublicKey };
  }

  static tuple(hubId: string, args: { planDigest: string; confirmationId: string; committedAt: string }): Buffer {
    // The labelled tuple agreed with S1 (hub-s48-init): exactly this JSON array.
    return Buffer.from(JSON.stringify(["agend-hub-init-v1", 1, hubId, args.planDigest, args.committedAt, args.confirmationId]));
  }

  async seal(args: { home: string; planDigest: string; confirmationId: string; committedAt: string }): Promise<string> {
    const identity = await this.read(args.home);
    if (!identity) throw new Error("no identity to seal with");
    return sign(null, FakeIdentity.tuple(identity.hubId, args), this.issuer.privateKey).toString("base64");
  }
}

export const ADMIN: DirectoryPerson = {
  key: { realm: "corp", objectId: "1463aac8-6aba-45fa-a172-f4a06ffa16ec" },
  login: "alice",
  dn: "uid=alice,ou=people,dc=example,dc=test",
  displayName: "Alice Example",
  groups: [],
};

/** A fake createHubDirectory: answers from a table; records what it was given. */
export function fakeDirectory(table: Record<string, SignInResult | { unavailable: string }>) {
  const calls: { bindPassword: string; login: string }[] = [];
  const create = ((_config: unknown, secrets: { bindPassword: string }, options?: { onDiagnostic?: (d: HubDirectoryDiagnostic) => void }): HubDirectory => ({
    realm: "corp",
    async signIn(login: string, password: string): Promise<SignInResult> {
      calls.push({ bindPassword: secrets.bindPassword, login });
      const row = table[`${login}:${password}`] ?? table[login];
      if (!row) return { ok: false, reason: "invalid-credentials" };
      if ("unavailable" in row) {
        options?.onDiagnostic?.({ op: "sign-in", outcome: "unavailable", error: row.unavailable });
        return { ok: false, reason: "unavailable" };
      }
      return row;
    },
    async checkEligibility() {
      return { eligible: false, reason: "unavailable" } as const;
    },
    async close() {},
  })) as unknown as typeof import("../../src/hub/directory/index.js").createHubDirectory;
  return { create, calls };
}

/** A scripted terminal: answers in order; hidden answers are tracked so tests can prove they were never printed. */
export function scriptedIO(answers: (string | { hidden: string })[]) {
  const queue = [...answers];
  const out: string[] = [];
  const prompts: string[] = [];
  const next = (question: string, hidden: boolean): string => {
    prompts.push(question);
    out.push(question);
    const answer = queue.shift();
    // An unscripted question fails the test (it must not pass as a cancellation: that would hide a wizard that went on).
    if (answer === undefined) throw new Error(`unscripted question: ${question}`);
    const isHidden = typeof answer === "object";
    if (isHidden !== hidden) throw new Error(`script mismatch at "${question}": expected a ${hidden ? "hidden" : "visible"} answer`);
    const value = isHidden ? answer.hidden : answer;
    if (!hidden) out.push(value);
    return value;
  };
  const io: WizardIO = {
    ask: async (q) => next(q, false),
    askHidden: async (q) => next(q, true),
    say: (line = "") => {
      out.push(line);
    },
  };
  return { io, out, prompts, remaining: () => queue.length, text: () => out.join("\n") };
}

export function publicKeyOfCert(certFile: string): string {
  return new X509Certificate(readFileSync(certFile)).publicKey.export({ type: "spki", format: "pem" }).toString();
}

export function spkiOfKey(keyFile: string): string {
  return createPublicKey(createPrivateKey(readFileSync(keyFile))).export({ type: "spki", format: "pem" }).toString();
}
