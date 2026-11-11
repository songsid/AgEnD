"""Owned checkout only; one valid source reversal at a time, byte-exact restoration even on failure."""
from pathlib import Path
import hashlib,json,subprocess,sys
root=Path.cwd(); out=root/'.artifacts/hub-enrolment-code-b1/mutations';out.mkdir(parents=True,exist_ok=True)
cases=[
 ('use-cas','src/hub/enrolment-code.ts',[
  ('WHERE id=? AND uses=? AND uses<max_uses','WHERE id=? AND uses<max_uses'),
  ('.run(c.id, expected.uses, this.deps.now())','.run(c.id, this.deps.now())')], 'tests/hub-enrolment-code-store-b1.test.ts','single-use receipts'),
 ('key-no-replacement','src/hub/enrolment-code.ts',[
  ('if (!create || this.deps.db.prepare("SELECT 1 FROM hub_enrolment_codes LIMIT 1").get() || this.deps.db.prepare("SELECT 1 FROM hub_enrolment_code_key").get())','if (!create)')], 'tests/hub-enrolment-code-store-b1.test.ts','missing key'),
 ('sealed-metadata','src/hub/enrolment-code.ts',[
  (' cipher.setAAD(this.aad(c));',''), ('      decipher.setAAD(this.aad(c)); ','      ')], 'tests/hub-enrolment-code-store-b1.test.ts','metadata cannot be widened'),
 ('scope-membership','src/hub/group-policy/store.ts',[
  ('&& facts.groups.includes(target.objectId)','&& true')], 'tests/hub-enrolment-code-permit-b1.test.ts','refuses nonmember'),
 ('scope-identity','src/hub/group-policy/store.ts',[
  ('&& facts.person.objectId === who.objectId','')], 'tests/hub-enrolment-code-permit-b1.test.ts','refuses foreign'),
 ('final-code-revoke','src/hub/enrolment-code.ts',[
  ('|| c.revokedAt !== null || c.expiresAt <= this.deps.now()','|| c.expiresAt <= this.deps.now()')], 'tests/hub-enrolment-code-http-b1.test.ts','last required audit'),
 ('no-legacy-publication','src/hub/catalog.ts',[
  ('if (fleetPermit.source === "code" && permit.source === "legacy") throw new HubGroupAuthorizationError("denied");','')], 'tests/hub-group-publication-enrollment.test.ts','code-granted Fleet'),
 ('v3-notice-queue','src/hub/pairing-notices.ts',[
  ('Number(link.features.has("pairing-notices-v3"))) as NoticeRow[]','Number(link.features.has("pairing-notices-v2"))) as NoticeRow[]')], 'tests/hub-pairing-notices.test.ts','code v3 notice stays'),
 ('invalid-budget','src/hub/join/service.ts',[
  ('spendEnrollmentBudget(state, "code:invalid", 11, now);','void 0;')], 'tests/hub-enrolment-code-http-b1.test.ts','eleven wrong codes'),
]
cases += [
 ('key-binding','src/hub/enrolment-code.ts',[
  ('if (binding ? binding.sha256 !== digest :','if (binding ? false :')], 'tests/hub-enrolment-code-store-b1.test.ts','valid replacement key'),
 ('key-durable-retry','src/hub/enrolment-code.ts',[
  ('      syncJoinPrivate(this.deps.home, suffix);','      // mutated flush')], 'tests/hub-enrolment-code-store-b1.test.ts','failed key flush'),
 ('create-final-image','src/hub/enrolment-code.ts',[
  ('const retained = this.assertDefinition(c); if (retained.uses !== 0) throw new HubProtocolError("revoked");','// mutated final create assertion')], 'tests/hub-enrolment-code-store-b1.test.ts','created response is refused'),
 ('captured-definition','src/hub/enrolment-code.ts',[
  ('if (!this.aad(current).equals(this.aad(expected))) throw new HubProtocolError("revoked");','')], 'tests/hub-enrolment-code-store-b1.test.ts','prepared immutable code'),
 ('approve-final-image','src/hub/join/service.ts',[
  ('if (code) { const current = this.codes.assertDefinition(code); if (current.uses + this.codeReservations(code.id) > current.maxUses) throw new HubProtocolError("revoked"); }','')], 'tests/hub-enrolment-code-http-b1.test.ts','approval audit cannot'),
 ('expired-reservation','src/hub/join/service.ts',[
  ('if (r.outerDeadline <= this.now() || r.stage === "identity-approved" && (r.redeemDeadline === null || r.redeemDeadline <= this.now()))','if (r.outerDeadline <= this.now())')], 'tests/hub-enrolment-code-http-b1.test.ts','expired redemption reservations'),
]
cases += [
 ('code-own-budget','src/hub/join/service.ts',[
  ('[[`code:${code.id}`, 120], ["code:all", 120]]','[[`code:${code.id}`, 999], ["code:all", 120]]')], 'tests/hub-enrolment-code-http-b1.test.ts','per-code and global 120'),
 ('code-global-budget','src/hub/join/service.ts',[
  ('[[`code:${code.id}`, 120], ["code:all", 120]]','[[`code:${code.id}`, 120], ["code:all", 999]]')], 'tests/hub-enrolment-code-http-b1.test.ts','per-code and global 120'),
]
cases += [
 ('never-admission','src/hub/group-policy/resources.ts',[
  ('if (p.denies.some(d => personKeyString(d.person) === personKeyString(r.owner) && d.deny.includes("pair_fleet")))','if (p.state !== "never-enabled" && p.denies.some(d => personKeyString(d.person) === personKeyString(r.owner) && d.deny.includes("pair_fleet")))')], 'tests/hub-enrolment-code-permit-b1.test.ts','never-enabled exclusion refuses'),
 ('never-retained','src/hub/group-policy/resources.ts',[
  ('(before.source === "code" || p.state !== "never-enabled")','(p.state !== "never-enabled")')], 'tests/hub-enrolment-code-permit-b1.test.ts','never-enabled exclusion suspends'),
 ('impact-source','src/hub/group-policy/impact-inventory.ts',[
  ('parseStoredHubGroupResource(parseStrictJson(row.body), row.source)','parseStoredHubGroupResource(parseStrictJson(row.body), "manual")')], 'tests/hub-enrolment-code-http-b1.test.ts','retained code provenance'),
 ('never-impact','src/hub/group-policy/admin-impact.ts',[
  ('const narrowing = row.lifecycle?.source === "code"','const narrowing = row.lifecycle?.source === "code" && next.state !== "never-enabled"')], 'tests/hub-enrolment-code-http-b1.test.ts','never-enabled preview names'),
 ('never-batch','src/hub/group-policy/resources.ts',[
  ('(before.source !== "code" || !p.denies.some','(true || !p.denies.some')], 'tests/hub-enrolment-code-http-b1.test.ts','never-enabled preview names'),
 ('member-version','src/settings-api.ts',[
  ('n.source === "code" && version >= 3','n.source === "code"')], 'tests/hub-pairing-api-s3c.test.ts','member Settings retains'),
]
cases += [
 ('code-resume','src/hub/group-policy/authorization.ts',[
  ('const retainedApproval = retainedSource === "code"','const retainedApproval = retainedSource === "code" && operation === "check"')], 'tests/hub-enrolment-code-http-b1.test.ts','real never-enabled admin resume'),
 ('manual-resume','src/hub/group-policy/authorization.ts',[
  ('operation === "check" && retainedSource === "manual"','(operation === "check" || operation === "resume") && retainedSource === "manual"')], 'tests/hub-enrolment-code-permit-b1.test.ts','resume preserves the manual'),
 ('resume-admin','src/hub/group-policy/authorization.ts',[
  ('if (authenticated.kind !== "directory" || personKeyString(validated(person, authenticated.person)) !== personKeyString(administrator))','if (authenticated.kind !== "directory")')], 'tests/hub-enrolment-code-permit-b1.test.ts','resume refuses a different admin'),
 ('resume-eligibility','src/hub/group-policy/resources.ts',[
  ('if (eligibility) {','if (eligibility && before.source !== "code") {')], 'tests/hub-enrolment-code-permit-b1.test.ts','resume refuses owner eligibility'),
 ('resume-epoch','src/hub/group-policy/authorization.ts',[
  ('if (operation === "resume" && previous !== epoch)','if (false && operation === "resume" && previous !== epoch)')], 'tests/hub-enrolment-code-permit-b1.test.ts','held eligibility fences never-enabled code resume after epoch'),
 ('resume-late','src/hub/group-policy/resources.ts',[
  ('if (state === "active") assert(ctx);','')], 'tests/hub-enrolment-code-permit-b1.test.ts','late invalidation cancellation'),
]
if len(sys.argv)>1: cases=[c for c in cases if c[0] in sys.argv[1:]]
results=[]
for name,path,edits,test,title in cases:
 p=root/path;raw=p.read_bytes();s=raw.decode()
 try:
  for old,new in edits:
   assert s.count(old)==1,(name,old,s.count(old));s=s.replace(old,new)
  p.write_text(s)
  compile=subprocess.run(['node_modules/.bin/tsc','--noEmit'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
  (out/(name+'-types.log')).write_bytes(compile.stdout)
  assert compile.returncode==0,(name,'mutation did not typecheck')
  r=subprocess.run(['node_modules/.bin/vitest','run',test,'-t',title,'--maxWorkers=1'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
  log=r.stdout.decode(errors='replace');(out/(name+'.log')).write_text(log)
  caught=r.returncode!=0 and ('AssertionError' in log or 'expected' in log) and 'Failed Tests' in log
  results.append(dict(guard=name,nativeTypes=compile.returncode,exit=r.returncode,semanticFailure=caught,restoredSha256=hashlib.sha256(raw).hexdigest()));print(json.dumps(results[-1]),flush=True)
 finally:p.write_bytes(raw)
(out/('receipt-'+('-'.join(sys.argv[1:]) or 'all')+'.json')).write_text(json.dumps(results,indent=2)+'\n');assert all(r['semanticFailure'] for r in results)
