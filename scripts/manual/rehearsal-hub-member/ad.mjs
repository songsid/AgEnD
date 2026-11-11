// ad.mjs: a private fake Active Directory (LDAPS on :636 inside the rig container only) — a plain-JS port of the
// repo's tests/support/hub-group-directory-wire.ts peer: bind/search/unbind, objectGUID, the AD extended-DN memberOf
// control, security groups. Dummy passwords only. Usage: node ad.mjs <cert> <key> <users.json> (run as root for :636)
import { createServer } from "node:tls";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/opt/adlib/package.json");
const { BerReader, BerWriter } = require("ldapts");
const [certFile, keyFile, usersFile] = process.argv.slice(2);
const users = JSON.parse(readFileSync(usersFile, "utf8"));       // [{id, login, dn, password, groups:[guid]}]
const groups = new Map([["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "CN=Owners,DC=example,DC=test"], ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "CN=Other,DC=example,DC=test"]]);
const guidBytes = (g) => { const h = g.replace(/-/g, ""); const b = Buffer.from(h, "hex");
  return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(), Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8)]); };
const server = createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, socket => {
  socket.on("error", () => {}); let buffer = Buffer.alloc(0);
  const reply = (id, tag, fill) => { const w = new BerWriter(); w.startSequence(); w.writeInt(id); w.startSequence(tag); fill(w); w.endSequence(); w.endSequence(); socket.write(w.buffer); };
  const result = (id, tag, code = 0) => reply(id, tag, w => { w.writeEnumeration(code); w.writeString(""); w.writeString(""); });
  const entry = (id, dn, attrs) => reply(id, 0x64, w => { w.writeString(dn); w.startSequence();
    for (const [name, values] of Object.entries(attrs)) { w.startSequence(); w.writeString(name); w.startSequence(0x31);
      for (const v of values) if (Buffer.isBuffer(v)) w.writeBuffer(v, 0x04); else w.writeString(v); w.endSequence(); w.endSequence(); }
    w.endSequence(); });
  const filter = (r) => { const tag = r.peek();
    if (tag === 0xa0 || tag === 0xa1 || tag === 0xa2) { r.readSequence(tag); const end = r.offset + r.length, children = []; while (r.offset < end) children.push(filter(r)); return { tag, children }; }
    if (tag === 0xa3) { r.readSequence(tag); return { attribute: r.readString(), value: r.readString(0x04, true) }; }
    if (tag === 0x87) return { present: r.readString(tag) };
    throw Error(`filter tag ${tag}`); };
  const equality = (f, name) => f.attribute === name ? f.value : f.children?.map(c => equality(c, name)).find(Boolean);
  socket.on("data", chunk => { buffer = Buffer.concat([buffer, chunk]);
    try { while (buffer.length) {
      if (buffer.length < 2) return; const r = new BerReader(buffer); r.readSequence(); if (r.remain < r.length) return;
      const frameLength = r.offset + r.length, id = r.readInt(), tag = r.readSequence();
      if (tag === 0x60) { r.readInt(); const dn = r.readString(), password = r.readString(0x80);
        const u = users.find(u => u.dn.toLowerCase() === dn.toLowerCase());
        const ok = (dn === "CN=Reader,DC=example,DC=test" && password === "Dummy-service-only") || (u && u.password === password);
        console.log("bind", dn, ok ? "ok" : "refused"); result(id, 0x61, ok ? 0 : 49); }
      else if (tag === 0x42) socket.end();
      else if (tag === 0x63) {
        const base = r.readString(), scope = r.readEnumeration(); r.readEnumeration(); r.readInt(); r.readInt(); r.readBoolean();
        const parsed = filter(r); r.readSequence(); const end = r.offset + r.length; while (r.offset < end) r.readString();
        let controls = 0;
        if (r.offset < frameLength && r.peek() === 0xa0) { r.readSequence(0xa0); const ce = r.offset + r.length; while (r.offset < ce) { r.readSequence(); const e2 = r.offset + r.length; r.readString(); r.readBoolean(); r.readString(0x04, true); r.offset = e2; controls++; } }
        const pg = equality(parsed, "objectGUID"), login = equality(parsed, "sAMAccountName")?.toString();
        const user = users.find(u => pg ? pg.equals(guidBytes(u.id)) : (login && u.login.toLowerCase() === login.toLowerCase()));
        const person = (u) => ({ objectGUID: [guidBytes(u.id)], userAccountControl: [u.eligible === false ? "514" : "512"], sAMAccountName: [u.login], displayName: [u.login] });
        if (controls) { if (user) entry(id, user.dn, { ...person(user), memberOf: (user.groups ?? []).map(g => `<GUID=${g}>;${groups.get(g)}`) }); result(id, 0x65); }
        else { const sel = [...groups].find(([g, dn]) => scope === 0 ? dn.toLowerCase() === base?.toLowerCase() : pg?.equals(guidBytes(g)));
          if (sel) entry(id, sel[1], { objectGUID: [guidBytes(sel[0])], groupType: ["-2147483646"] }); else if (user) entry(id, user.dn, person(user));
          result(id, 0x65); }
      } else throw Error(`op ${tag}`);
      buffer = buffer.subarray(frameLength);
    } } catch (e) { console.log("drop", e.message); socket.destroy(); } });
});
server.listen(636, "127.0.0.1", () => console.log("AD READY"));
