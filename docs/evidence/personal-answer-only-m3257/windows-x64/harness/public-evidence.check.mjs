import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publicEvidence,assertPublicEvidence,writePublicEvidence} from './public-evidence.mjs';
const profile=['C:','Users','Synthetic Operator'].join('\\');
const options={repo:'/example/repository',home:'/example/home',environment:{USERPROFILE:profile,COMPUTERNAME:'SYNTHETIC-PC',USERDOMAIN:'SYNTHETIC-LAN',USERNAME:'Synthetic Operator'}};
test('redacts nested ledger paths before writing while preserving proof outcomes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'proof-redaction-'));
 try{
  const path=join(dir,'ledger.json');writePublicEvidence(path,{root:profile+'\\proof',created:[profile+'\\proof\\auth'],removed:[profile+'\\proof'],checks:{authConfigBytesUnchanged:true},modelAttempts:1},{...options,repo:profile+'\\proof'});
  assert.deepEqual(JSON.parse(readFileSync(path)),{root:'%USERPROFILE%\\proof',created:['%USERPROFILE%\\proof\\auth'],removed:['%USERPROFILE%\\proof'],checks:{authConfigBytesUnchanged:true},modelAttempts:1});
  assertPublicEvidence(readFileSync(path,'utf8'),options);
 }finally{rmSync(dir,{recursive:true});}
});
test('unknown/case-varied Windows and WSL profile paths are removed too',()=>{
 const other=['d:','users','Another Synthetic User','proof'].join('\\');
 assert.deepEqual(publicEvidence([other,'/mnt/c/Users/Synthetic User/proof'],options),['%USERPROFILE%\\proof','%USERPROFILE%/proof']);
});
test('redacts repository and Linux home paths in old plain-text logs',()=>{
 assert.deepEqual(publicEvidence(['/example/repository/tests/test.ts','/home/synthetic/.nvm/node'],options),['%REPO%/tests/test.ts','%HOME%/.nvm/node']);
});
test('redacts host identity fields and non-loopback network identifiers',()=>{
 const input={hostname:'example',domain:'example',sid:'S-1-5-21-123-456-789-1001',email:'proof@example.test',mac:'02:11:22:33:44:55',ip:'192.0.2.5',line:'SYNTHETIC-PC SYNTHETIC-LAN proof@example.test 192.0.2.5 02:11:22:33:44:55'};
 const value=publicEvidence(input,options);assert.equal(value.hostname,'%COMPUTERNAME%');assert.equal(value.domain,'%DOMAIN%');assert.equal(value.sid,'%SID%');assert.equal(value.email,'%EMAIL%');assert.equal(value.mac,'%MAC%');assert.equal(value.ip,'%HOST_IP%');
 assert.equal(value.line,'%COMPUTERNAME% %DOMAIN% %EMAIL% %HOST_IP% %MAC%');assertPublicEvidence(value,options);
});
test('keeps version numbers, source SHA and the standard loopback trap literal',()=>{
 const input={version:'10.0.26100.9711',sha:'6a7aeaacbe913cd54b9d12b7ca874db92e7b6446',trap:'http://127.0.0.1:12345/owned',hits:0};
 assert.deepEqual(publicEvidence(input,options),input);assertPublicEvidence(input,options);
});
test('rejects raw private evidence without echoing the private value',()=>{
 assert.throws(()=>assertPublicEvidence({root:profile+'\\proof'},options),error=>!error.message.includes('Synthetic Operator')&&/refused/.test(error.message));
});
