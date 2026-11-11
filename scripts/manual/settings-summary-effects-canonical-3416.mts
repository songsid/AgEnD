/** Pure alpha effect replay against an owned checkout; no writes or runtime. */
import fs from 'node:fs';import cp from 'node:child_process';import crypto from 'node:crypto';import path from 'node:path';
import {effectSummaryCases} from '../../tests/helpers/settings-summary-effects-3416.js';
const repo=process.cwd(),baseline=path.resolve(process.env.BASELINE!),out=path.resolve(process.env.OUT!);fs.mkdirSync(out,{recursive:true});
const hash=(p:string)=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const git=(at:string,...args:string[])=>cp.execFileSync('git',args,{cwd:at,encoding:'utf8'}).trim();
const run=async(at:string)=>{
 const [effects,pairing,exposure,locale]=await Promise.all(['settings-effect.ts','hub-pairing-summary.ts','hub/member/exposure-api.ts','locale.ts'].map(p=>import(path.join(at,'src',p))));
 const values=[];for(const language of ['en','zh-TW'] as const){locale.setLocale(language);for(const c of effectSummaryCases({...effects,...pairing,...exposure} as any)){
  try{values.push({language,name:c.name,value:JSON.parse(JSON.stringify(c.read(),(key,value)=>key==='summary_i18n'?undefined:value))});}
  catch(e:any){values.push({language,name:c.name,error:{name:e.name,code:e.code,message:e.message}})}
 }}return values;
};
const before=await run(baseline),after=await run(repo),identical=JSON.stringify(before)===JSON.stringify(after);
const inputs=['src/settings-effect.ts','src/hub-pairing-summary.ts','src/hub/member/exposure-api.ts','src/locale.ts','tests/helpers/settings-summary-effects-3416.ts','scripts/manual/settings-summary-effects-canonical-3416.mts'];
fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify({baseline:git(baseline,'rev-parse','HEAD'),candidate:git(repo,'rev-parse','HEAD'),dirty:git(repo,'status','--porcelain','--untracked-files=no'),inputs:inputs.map(p=>({digest:hash(path.join(repo,p)),paths:[p]})),cases:after.length,identical,before,after,scope:'Pure held-effect and preview replay. Only optional display metadata excluded; raw summary, fingerprint, classification, authority and refusals compared byte-for-byte. No account, CLI, native runtime or Settings execution.'},null,2)+'\n');
if(!identical)throw Error('canonical effect output changed');console.log(JSON.stringify({cases:after.length,identical}));
