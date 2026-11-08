/** Private, loopback-only LDAP wire peer. It implements only test bind/search/unbind, no external directory. */
import { createServer, type TLSSocket } from "node:tls";
import { BerReader, BerWriter } from "ldapts";
import { guidStringToBytes } from "../../src/hub/directory/profiles.js";
export const GROUP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", GROUP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const PERSON_ID = "11111111-1111-4111-8111-111111111111", GROUP_DN = "CN=Owners,DC=example,DC=test";
/** Optional recorded users also exercise production browser sign-in/eligibility; dummy passwords only. */
export interface GroupWireUser { id: string; login: string; dn: string; password: string; eligible?: boolean; groups?: string[] }
export async function groupWirePeer(material: { cert: string; key: string }, users?: GroupWireUser[]) {
  const sockets = new Set<TLSSocket>(), binds: string[] = [], searches: any[] = [];
  const state = { mode: "ok" as "ok" | "unsupported" | "outage" | "referral" | "plain" | "missing" | "ranged", memberships: [GROUP_A],
    labels: new Map([[GROUP_A, GROUP_DN], [GROUP_B, "CN=Other,DC=example,DC=test"]]), beforeMembership: undefined as (() => void) | undefined };
  const server = createServer(material, socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); let buffer = Buffer.alloc(0);
    const reply = (id: number, tag: number, fill: (w: BerWriter) => void) => {
      const w = new BerWriter(); w.startSequence(); w.writeInt(id); w.startSequence(tag); fill(w); w.endSequence(); w.endSequence(); socket.write(w.buffer);
    };
    const result = (id: number, tag: number, code = 0) => reply(id, tag, w => { w.writeEnumeration(code); w.writeString(""); w.writeString(""); });
    const entry = (id: number, dn: string, attrs: Record<string, Array<string | Buffer>>) => reply(id, 0x64, w => {
      w.writeString(dn); w.startSequence();
      for (const [name, values] of Object.entries(attrs)) {
        w.startSequence(); w.writeString(name); w.startSequence(0x31);
        for (const value of values) if (Buffer.isBuffer(value)) w.writeBuffer(value, 0x04); else w.writeString(value);
        w.endSequence(); w.endSequence();
      }
      w.endSequence();
    });
    const filter = (r: BerReader): any => {
      const tag = r.peek();
      if (tag === 0xa0 || tag === 0xa1 || tag === 0xa2) { r.readSequence(tag); const end = r.offset + r.length, children: any[] = []; while (r.offset < end) children.push(filter(r)); return { tag, children }; }
      if (tag === 0xa3) { r.readSequence(tag); return { attribute: r.readString(), value: r.readString(0x04, true) }; }
      if (tag === 0x87) return { present: r.readString(tag) };
      throw Error(`Unexpected inert-filter tag ${tag}`);
    };
    const equality = (f: any, name: string): Buffer | undefined => f.attribute === name ? f.value : f.children?.map((c: any) => equality(c, name)).find(Boolean);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      try { while (buffer.length) {
        if (buffer.length < 2) return; const r = new BerReader(buffer); r.readSequence(); if (r.remain < r.length) return;
        const frameLength = r.offset + r.length, id = r.readInt()!, tag = r.readSequence();
        if (tag === 0x60) {
          r.readInt(); const dn = r.readString()!, password = r.readString(0x80); binds.push(dn);
          const user = users?.find(u => u.dn.toLowerCase() === dn.toLowerCase());
          result(id, 0x61, users && !(dn === "CN=Reader,DC=example,DC=test" && password === "Dummy-service-only")
            && !(user && user.password === password) ? 49 : 0);
        }
        else if (tag === 0x42) socket.end();
        else if (tag === 0x63) {
          const base = r.readString(), scope = r.readEnumeration(), deref = r.readEnumeration(), sizeLimit = r.readInt(); r.readInt(); r.readBoolean();
          const parsed = filter(r); r.readSequence(); const end = r.offset + r.length, attributes: string[] = []; while (r.offset < end) attributes.push(r.readString()!);
          const controls: any[] = [];
          if (r.offset < frameLength && r.peek() === 0xa0) {
            r.readSequence(0xa0); const controlsEnd = r.offset + r.length;
            while (r.offset < controlsEnd) { r.readSequence(); const controlEnd = r.offset + r.length, oid = r.readString(), critical = r.readBoolean(), value = r.readString(0x04, true); controls.push({ oid, critical, hex: value?.toString("hex") }); if (r.offset !== controlEnd) throw Error("Invalid control boundary"); }
          }
          searches.push({ base, scope, deref, sizeLimit, attributes, controls, filter: parsed });
          const personGuid = equality(parsed, "objectGUID"), login = equality(parsed, "sAMAccountName")?.toString();
          const user = users?.find(u => personGuid ? personGuid.equals(guidStringToBytes(u.id)!) : u.login.toLowerCase() === login?.toLowerCase());
          const personAttributes = (selected?: GroupWireUser): Record<string, Array<string | Buffer>> => ({
            objectGUID: [guidStringToBytes(selected?.id ?? PERSON_ID)!], userAccountControl: [selected?.eligible === false ? "514" : "512"],
            sAMAccountName: [selected?.login ?? "person"], displayName: [selected?.login ?? "Person"],
          });
          if (controls.length) {
            state.beforeMembership?.();
            if (state.mode === "outage") socket.destroy();
            else if (state.mode === "unsupported") result(id, 0x65, 12);
            else {
              const attrs = personAttributes(user);
              if (state.mode !== "missing") attrs[state.mode === "ranged" ? "memberOf;range=0-1499" : "memberOf"] = (user?.groups ?? state.memberships).map(g => state.mode === "plain" ? state.labels.get(g)! : `<GUID=${g}>;${state.labels.get(g)}`);
              if (!users || user) entry(id, user?.dn ?? "CN=Person,DC=example,DC=test", attrs);
              if (state.mode === "referral") reply(id, 0x73, w => w.writeString("ldaps://other.invalid"));
              result(id, 0x65);
            }
          } else {
            const raw = equality(parsed, "objectGUID");
            const selected = [...state.labels].find(([guid, dn]) => scope === 0 ? dn.toLowerCase() === base?.toLowerCase() : raw?.equals(guidStringToBytes(guid)!));
            if (selected) entry(id, selected[1], { objectGUID: [guidStringToBytes(selected[0])!], groupType: ["-2147483646"] });
            else if (user) entry(id, user.dn, personAttributes(user));
            result(id, 0x65);
          }
        } else throw Error(`Unexpected inert-LDAP operation ${tag}`);
        buffer = buffer.subarray(frameLength);
      } } catch { socket.destroy(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { state, searches, binds, port: (server.address() as { port: number }).port,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
