/** Private, loopback-only LDAP wire peer. It implements only test bind/search/unbind, no external directory. */
import { createServer, type TLSSocket } from "node:tls";
import { X509Certificate } from "node:crypto";
import { BerReader, BerWriter } from "ldapts";
import { guidStringToBytes } from "../../src/hub/directory/profiles.js";
export const GROUP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", GROUP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const PERSON_ID = "11111111-1111-4111-8111-111111111111", GROUP_DN = "CN=Owners,DC=example,DC=test";
/** Optional recorded users also exercise production browser sign-in/eligibility; dummy passwords only. */
export interface GroupWireUser { id: string; login: string; dn: string; password: string; eligible?: boolean; groups?: string[] }
export async function groupWirePeer(material: { cert: string; key: string }, users?: GroupWireUser[], ca?: { dn: string; pem: string; requireBind?: boolean }) {
  const sockets = new Set<TLSSocket>(), binds: string[] = [], bindRecords: Array<{ dn: string; password: string }> = [], searches: any[] = [];
  // "continuation" (M-2724): as AD does for every subtree search at a domain root, each one also returns continuation
  // references to the DNS-zone and Configuration partitions, whether or not it found the entry.
  const state = { mode: "ok" as "ok" | "unsupported" | "outage" | "referral" | "plain" | "missing" | "ranged" | "continuation", memberships: [GROUP_A],
    holdGroupSearch: false,
    labels: new Map([[GROUP_A, GROUP_DN], [GROUP_B, "CN=Other,DC=example,DC=test"]]), beforeMembership: undefined as (() => void) | undefined };
  const server = createServer(material, socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); let buffer = Buffer.alloc(0), bound = false;
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
      if (tag === 0xa4) {
        r.readSequence(tag); const substring = r.readString(); r.readSequence(); const end = r.offset + r.length;
        const result: any = { substring };
        while (r.offset < end) { const part = r.peek()!; const text = r.readString(part); result[part === 0x80 ? "initial" : part === 0x82 ? "final" : "any"] = text; }
        return result;
      }
      if (tag === 0xa9) {
        r.readSequence(tag); const end = r.offset + r.length, result: any = {};
        while (r.offset < end) { const part = r.peek()!; result[part === 0x81 ? "rule" : part === 0x82 ? "attribute" : "value"] = r.readString(part); }
        return { extensible: result };
      }
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
          bindRecords.push({ dn, password: password! });
          const user = users?.find(u => u.dn.toLowerCase() === dn.toLowerCase());
          const accepted = !users || (dn === "CN=Reader,DC=example,DC=test" && password === "Dummy-service-only")
            || !!(user && user.password === password) || !!(ca && !dn && !password);
          bound = accepted && !!dn; result(id, 0x61, accepted ? 0 : 49);
        }
        else if (tag === 0x42) socket.end();
        else if (tag === 0x63) {
          const base = r.readString(), scope = r.readEnumeration(), deref = r.readEnumeration(), sizeLimit = r.readInt(), timeLimit = r.readInt(); r.readBoolean();
          const parsed = filter(r); r.readSequence(); const end = r.offset + r.length, attributes: string[] = []; while (r.offset < end) attributes.push(r.readString()!);
          const controls: any[] = [];
          if (r.offset < frameLength && r.peek() === 0xa0) {
            r.readSequence(0xa0); const controlsEnd = r.offset + r.length;
            while (r.offset < controlsEnd) { r.readSequence(); const controlEnd = r.offset + r.length, oid = r.readString(), critical = r.readBoolean(), value = r.readString(0x04, true); controls.push({ oid, critical, hex: value?.toString("hex") }); if (r.offset !== controlEnd) throw Error("Invalid control boundary"); }
          }
          searches.push({ base, scope, deref, sizeLimit, timeLimit, attributes, controls, filter: parsed });
          const continuation = () => { if (state.mode === "continuation" && scope === 2) for (const part of ["DC=DomainDnsZones", "DC=ForestDnsZones", "CN=Configuration"]) reply(id, 0x73, w => w.writeString(`ldaps://example.test/${part},DC=example,DC=test`)); };
          const personGuid = equality(parsed, "objectGUID"), login = equality(parsed, "sAMAccountName")?.toString();
          const user = users?.find(u => personGuid ? personGuid.equals(guidStringToBytes(u.id)!) : u.login.toLowerCase() === login?.toLowerCase());
          const personAttributes = (selected?: GroupWireUser): Record<string, Array<string | Buffer>> => ({
            objectGUID: [guidStringToBytes(selected?.id ?? PERSON_ID)!], userAccountControl: [selected?.eligible === false ? "514" : "512"],
            sAMAccountName: [selected?.login ?? "person"], displayName: [selected?.login ?? "Person"],
          });
          if (ca && base?.toLowerCase() === ca.dn.toLowerCase()) {
            if (ca.requireBind && !bound) result(id, 0x65, 50);
            else { entry(id, ca.dn, { "cACertificate;binary": [new X509Certificate(ca.pem).raw] }); result(id, 0x65); }
          } else if (attributes.includes("distinguishedName") && attributes.includes("cn")) {
            if (state.holdGroupSearch) { buffer = buffer.subarray(frameLength); continue; }
            const matches = (f: any, cn: string): boolean => {
              if (f.tag === 0xa0) return f.children.every((c: any) => matches(c, cn));
              if (f.tag === 0xa1) return f.children.some((c: any) => matches(c, cn));
              if (f.tag === 0xa2) return !matches(f.children[0], cn);
              if (f.substring) {
                const value = ["cn", "sAMAccountName"].includes(f.substring) ? cn.toLowerCase() : "";
                return !!value && (!f.initial || value.startsWith(f.initial.toLowerCase())) && (!f.final || value.endsWith(f.final.toLowerCase()))
                  && (!f.any || value.includes(f.any.toLowerCase()));
              }
              if (f.extensible) return f.extensible.attribute === "groupType" && f.extensible.rule === "1.2.840.113556.1.4.803" && f.extensible.value === "2147483648";
              if (f.present) return ["cn", "sAMAccountName", "objectCategory", "groupType"].includes(f.present);
              return f.attribute === "objectCategory" && f.value.toString().toLowerCase() === "group";
            };
            const matching = [...state.labels].map(([id, dn]) => ({ id, dn, cn: /^CN=([^,]+)/i.exec(dn)?.[1] ?? "" })).filter(g => matches(parsed, g.cn));
            for (const g of matching.slice(0, sizeLimit!)) entry(id, g.dn, { objectGUID: [guidStringToBytes(g.id)!], cn: [g.cn], distinguishedName: [g.dn] });
            continuation(); result(id, 0x65, matching.length > sizeLimit! ? 4 : 0);
          } else if (controls.length) {
            state.beforeMembership?.();
            if (state.mode === "outage") socket.destroy();
            else if (state.mode === "unsupported") result(id, 0x65, 12);
            else {
              const attrs = personAttributes(user);
              if (state.mode !== "missing") attrs[state.mode === "ranged" ? "memberOf;range=0-1499" : "memberOf"] = (user?.groups ?? state.memberships).map(g => state.mode === "plain" ? state.labels.get(g)! : `<GUID=${g}>;${state.labels.get(g)}`);
              if (!users || user) entry(id, user?.dn ?? "CN=Person,DC=example,DC=test", attrs);
              if (state.mode === "referral") reply(id, 0x73, w => w.writeString("ldaps://other.invalid"));
              continuation(); result(id, 0x65);
            }
          } else {
            const raw = equality(parsed, "objectGUID");
            const selected = [...state.labels].find(([guid, dn]) => scope === 0 ? dn.toLowerCase() === base?.toLowerCase() : raw?.equals(guidStringToBytes(guid)!));
            if (selected) entry(id, selected[1], { objectGUID: [guidStringToBytes(selected[0])!], groupType: ["-2147483646"] });
            else if (user) entry(id, user.dn, personAttributes(user));
            continuation(); result(id, 0x65);
          }
        } else throw Error(`Unexpected inert-LDAP operation ${tag}`);
        buffer = buffer.subarray(frameLength);
      } } catch { socket.destroy(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { state, searches, binds, bindRecords, port: (server.address() as { port: number }).port, openSockets: () => sockets.size,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
