/** Private test-only certificate builder, following runtime-private-network's in-memory fixture. */
import { generateKeyPairSync, sign } from "node:crypto";
export function runtimeUpdateTlsFixture() {
  const der = (tag: number, ...parts: Buffer[]): Buffer => {
    const value = Buffer.concat(parts), hex = value.length.toString(16).padStart(Math.ceil(value.length.toString(16).length / 2) * 2, "0");
    const wide = Buffer.from(hex, "hex"), length = value.length < 128 ? Buffer.from([value.length]) : Buffer.concat([Buffer.from([0x80 | wide.length]), wide]);
    return Buffer.concat([Buffer.from([tag]), length, value]);
  };
  const seq = (...parts: Buffer[]) => der(0x30, ...parts), oid = (hex: string) => der(0x06, Buffer.from(hex, "hex"));
  const time = (value: number) => der(0x18, Buffer.from(new Date(value).toISOString().replace(/[-:]/g, "").replace("T", "").slice(0, 14) + "Z"));
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algorithm = seq(oid("2a864886f70d01010b"), der(0x05));
  const name = seq(der(0x31, seq(oid("550403"), der(0x0c, Buffer.from("localhost")))));
  const san = seq(der(0x82, Buffer.from("localhost")), der(0x87, Buffer.from([127, 0, 0, 1])));
  const extensions = der(0xa3, seq(seq(oid("551d13"), der(0x01, Buffer.from([0xff])), der(0x04, seq(der(0x01, Buffer.from([0xff]))))), seq(oid("551d11"), der(0x04, san))));
  const now = Date.now(), tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), algorithm, name,
    seq(time(now - 60_000), time(now + 86_400_000)), name, publicKey.export({ type: "spki", format: "der" }), extensions);
  const bytes = seq(tbs, algorithm, der(0x03, Buffer.from([0]), sign("sha256", tbs, privateKey)));
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }), cert: `-----BEGIN CERTIFICATE-----\n${bytes.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n` };
}
