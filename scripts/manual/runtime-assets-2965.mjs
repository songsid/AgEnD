import { readFileSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { createRuntimeBundle } from '../../dist/runtime-bundle.js';
import { RUNTIME_PANE_ASSETS } from '../../dist/runtime-pane-assets.js';
const root=process.cwd(), artifact=join(root,'.artifacts/n7-n9'), baseline=join(artifact,'baseline-assets');
cpSync(join(root,'dist/runtime-assets'),baseline,{recursive:true});
const pack=JSON.parse(readFileSync(join(artifact,'upstream-pack.json'),'utf8'))[0];
const tar=readFileSync(join(artifact,'node-pty-1.1.0.tgz'));
const expected='sha512-20JqtutY6JPXTUnL0ij1uad7Qe1baT46lyolh2sSENDd4sTzKZ4nmAFkeAARDKwmlLjPx6XKRlwRUxwjOy+lUg==';
if(pack.name!=='node-pty'||pack.version!=='1.1.0'||pack.integrity!==expected||'sha512-'+createHash('sha512').update(tar).digest('base64')!==expected) throw Error('bad upstream archive');
// The old builder takes these exact archive files, plus the existing ConPTY license supplements.
const { execFileSync }=await import('node:child_process');
let checked=0;
for(const pkg of RUNTIME_PANE_ASSETS.filter(p=>p.name==='node-pty')) for(const file of pkg.files){
 const bytes=file.startsWith('CONPTY-')?readFileSync(join(root,'templates/runtime-assets','conpty-'+file.slice(7))):execFileSync('tar',['-xOf',join(artifact,'node-pty-1.1.0.tgz'),'package/'+file],{maxBuffer:4*1024*1024});
 const dest=join(baseline,pkg.name,file);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,bytes);
 checked++;
 if(!bytes.equals(readFileSync(join(root,'dist/runtime-assets',pkg.name,file)))) throw Error('changed Runtime asset '+file);
}
if(checked!==25)throw Error('Expected all25 existing node-pty assets');
const options={moduleDirectory:join(root,'dist'),packageVersion:'2.3.5-2965-fixture'};
const before=createRuntimeBundle({...options,paneAssetDirectory:baseline}), after=createRuntimeBundle({...options,paneAssetDirectory:join(root,'dist/runtime-assets')});
if(!before.bytes.equals(after.bytes))throw Error('Runtime ZIP changed');
console.log(JSON.stringify({files:RUNTIME_PANE_ASSETS.reduce((n,p)=>n+p.files.length,0),before:before.sha256,after:after.sha256,bytes:after.bytes.length,identical:true}));
