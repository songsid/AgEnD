import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { backendSignInGuide } from '../src/backend-signin-guide.js';
it('guide navigation accepts only canonical IDs, never commands, URLs or empty lists',()=>{
 expect(backendSignInGuide(undefined)).toBe('');
 expect(backendSignInGuide('codex,kiro-cli,codex')).toBe('/settings/agents?backend_signins=codex%2Ckiro-cli');
 for(const csv of ['', 'codex,', 'codex;id', 'https://example.org', 'codex,codex,codex,codex,codex']) expect(backendSignInGuide(csv)).toBeNull();
});
it('the real CLI mints a code locally and prints only non-secret navigation, without starting setup or a backend',async()=>{
 const home=mkdtempSync(join(tmpdir(),'agend-2599-guide-'));const requests: unknown[]=[];
 const token='stub-header-credential';const code='ABCD-EFGH';
 const server=createServer((req,res)=>{requests.push([req.method,req.url,req.headers['x-agend-token']]);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code,expiresAt:Date.now()+60000}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
 try{
  writeFileSync(join(home,'web.token'),token,{mode:0o600});
  writeFileSync(join(home,'fleet.yaml'),`health_port: ${port}\ninstances: {}\n`);
  const cli=[resolve('node_modules/tsx/dist/cli.mjs'),'src/cli.ts','web','--code'];
  const {stdout,stderr}=await promisify(execFile)(process.execPath,[...cli,'--backend-signins','kiro-cli,codex'],{env:{...process.env,AGEND_HOME:home},timeout:15000});
  const signin=new URL(stdout.match(/Sign-in page: (\S+)/)![1]!);
  expect(signin.origin).toBe(`http://localhost:${port}`);
  expect(signin.pathname).toBe('/signin');expect(signin.searchParams.get('next')).toBe('/settings/agents?backend_signins=kiro-cli%2Ccodex');
  expect(stdout).toContain(code);expect(stdout+stderr).not.toContain(token);
  expect(requests).toEqual([['POST','/auth/issue-code',token]]);
  expect(readFileSync(join(home,'fleet.yaml'),'utf8')).toBe(`health_port: ${port}\ninstances: {}\n`);
  await expect(promisify(execFile)(process.execPath,[...cli,'--backend-signins','codex;id'],{env:{...process.env,AGEND_HOME:home},timeout:15000})).rejects.toMatchObject({code:1});
  expect(requests).toHaveLength(1);
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(home,{recursive:true,force:true});}
},40000);
