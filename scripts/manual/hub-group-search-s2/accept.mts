/** Standalone real Hub/verified fake-LDAPS acceptance; owned no-network container only. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
if (process.env.AGEND_OWNED_CONTAINER !== "hub-group-search-s2" || !existsSync("/.dockerenv") || process.env.SAFE_RUN !== "1") throw Error("Owned SAFE_RUN container required");
const out = process.env.OUT!; mkdirSync(out, { recursive: true });
const receipt: any = { checks: [], boundary: "Production source Hub HTTP/admin/CSRF + verified synthetic LDAPS in network-none container. No systemd, browser UI, native or live-directory claim." };
const check = (name: string, pass: boolean) => { receipt.checks.push({ name, pass }); if (!pass) throw Error(name); };
const tls = createRequire(import.meta.url)("node:tls"), connect = tls.connect; let port = 0;
tls.connect = (options: any, ...args: any[]) => connect({ ...options, ...(options.host === "127.0.0.1" && options.port === 636 ? { port } : {}) }, ...args); syncBuiltinESMExports();
const { companyJoinRig } = await import("../../../tests/support/hub-company-join-rig.js");
const { GROUP_A } = await import("../../../tests/support/hub-group-directory-wire.js");
let rig: Awaited<ReturnType<typeof companyJoinRig>> | undefined;
try {
  const r = rig = await companyJoinRig(p => { port = p; }), admin = await r.signIn("alice"), person = await r.signIn("carol");
  const path = "/hub/v1/admin/group-policy/search", search = (q: string) => r.call(admin, "POST", path, { q });
  const result = await search(" oWn ");
  check("S2-L1 case-insensitive prefix finds Owners", result.status === 200 && result.body.groups[0]?.objectId === GROUP_A);
  const wire = r.wire.searches.find(row => row.sizeLimit === 20)!;
  check("LDAP bounded subtree projection", wire.scope === 2 && wire.deref === 0 && wire.timeLimit === 5 && JSON.stringify(wire.attributes) === JSON.stringify(["objectGUID", "cn", "distinguishedName"]));
  check("S2-L1 short prefix refused", (await search("x")).status === 400);
  const escaped = await search("*)(cn=*"); check("S2-L2 literal filter, no suggestions", escaped.status === 200 && escaped.body.groups.length === 0);
  check("S2-L2 literal text reaches wire", JSON.stringify(r.wire.searches.filter(row => row.sizeLimit === 20).at(-1)!.filter).includes("*)(cn=*"));
  for (let i = 0; i < 21; i++) r.wire.state.labels.set(randomUUID(), `CN=Search${String(i).padStart(2, "0")},DC=example,DC=test`);
  r.wire.state.mode = "continuation";
  const capped = await search("Search"); check("S2-L3 21 matches, 20 capped, continuation ignored", capped.status === 200 && capped.body.groups.length === 20 && capped.body.truncated === true);
  check("S2-L4 non-admin refused", (await r.call(person, "POST", path, { q: "own" })).status === 403);
  check("S2-L4 missing CSRF refused", (await r.call(admin, "POST", path, { q: "own" }, { "X-AgEnD-Hub-CSRF": "" })).status === 403);
  check("S2-L4 cross-origin refused", (await r.call(admin, "POST", path, { q: "own" }, { Origin: "https://elsewhere.invalid" })).status === 403);
  const fresh = await r.signIn("alice");
  for (let i = 0; i < 30; i++) check(`S2-L4 allowed search ${i + 1}`, (await r.call(fresh, "POST", path, { q: "own" })).status === 200);
  check("S2-L4 31st refused", (await r.call(fresh, "POST", path, { q: "own" })).status === 429);
  r.wire.state.holdGroupSearch = true;
  const before = Date.now(), timeout = await r.directory.searchPolicyGroups!("own");
  check("owned non-answering read bounded", !timeout.ok && timeout.reason === "unknown" && Date.now() - before < 7500);
  check("physical directory socket settled", r.wire.openSockets() === 0);
  check("search grants no resource", (r.db.prepare("SELECT COUNT(*) n FROM hub_group_resources").get() as { n: number }).n === 0);
  receipt.pass = true;
} catch (error) { receipt.error = String(error); process.exitCode = 1; }
finally {
  await rig?.close(); tls.connect = connect; syncBuiltinESMExports(); receipt.cleaned = true;
  receipt.production = ["src/hub/directory/directory.ts", "src/hub/directory/groups.ts", "src/hub/directory/types.ts", "src/hub/group-policy/admin-search.ts", "src/hub/group-policy/admin-api.ts", "src/hub/group-policy/admin-control.ts", "src/hub/group-policy/admin-dto.ts", "src/hub/http/compose.ts"].map(path => ({ path, digest: createHash("sha256").update(readFileSync(path)).digest("hex") }));
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify({ pass: receipt.pass === true, checks: receipt.checks.length, error: receipt.error }));
process.exit(receipt.pass ? 0 : 1);
