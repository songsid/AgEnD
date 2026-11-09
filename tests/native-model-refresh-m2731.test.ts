import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {refreshNativeModels} from '../src/windows-cli-worker.js';
const roots:string[]=[];
afterEach(()=>{roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});
function rig(){const home=mkdtempSync(join(tmpdir(),'native-model-refresh-'));roots.push(home);const dir=join(home,'selected-profile');mkdirSync(dir);mkdirSync(join(home,'.claude'));writeFileSync(join(home,'.claude','.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'ambient-must-not-be-used'}}));return {home,dir};}
it('uses only the selected Claude profile token in a fixed vendor rediscovery, never ambient auth',async()=>{
 const {home,dir}=rig();writeFileSync(join(dir,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'selected-secret'}}));
 const request=vi.fn(async()=>new Response(JSON.stringify({data:[{id:'claude-new',display_name:'New'}]}),{status:200}));
 const result=await refreshNativeModels({cli:'claude-code',directory:dir,home,environment:{},request:request as never});
 expect(result.models.map(m=>m.id)).toContain('claude-new');expect(result.source).toBe('account-api');
 expect(request).toHaveBeenCalledOnce();expect(request.mock.calls[0]).toMatchObject(['https://api.anthropic.com/v1/models?limit=100',{headers:{Authorization:'Bearer selected-secret'},redirect:'error'}]);
 expect(JSON.stringify(result)).not.toContain('selected-secret');
});
it('missing selected credentials never try the ambient account, documented aliases, or network',async()=>{
 const {home,dir}=rig();const request=vi.fn();await expect(refreshNativeModels({cli:'claude-code',directory:dir,home,environment:{CLAUDE_CONFIG_DIR:join(home,'other')},request})).rejects.toThrow();expect(request).not.toHaveBeenCalled();
});
it('Codex performs guarded vendor refresh then reads that same native home, and rejects custom providers',async()=>{
 const {home}=rig(),dir=join(home,'.codex');mkdirSync(dir);writeFileSync(join(dir,'config.toml'),'model_provider="openai"\n');
 const run=vi.fn(async()=>{writeFileSync(join(dir,'models_cache.json'),JSON.stringify({models:[{slug:'fresh-codex',display_name:'Fresh'}]}));return {ok:true,text:'ignored'};});
 const opts={cli:'codex',home,environment:{},find:async()=>({path:'C:\\codex.exe',command:'C:\\codex.exe',args:[]}),run};
 const result=await refreshNativeModels(opts);expect(result.models).toEqual([{id:'fresh-codex',name:'Fresh'}]);expect(run).toHaveBeenCalledWith(expect.anything(),['-c','check_for_update_on_startup=false','debug','models'],expect.objectContaining({CODEX_HOME:dir}));
 writeFileSync(join(dir,'config.toml'),'model_provider="custom"\n');await expect(refreshNativeModels(opts)).rejects.toThrow();expect(run).toHaveBeenCalledOnce();
});
it('a revoked operation or failed API is not fresh, and no response secrets or raw errors escape',async()=>{
 const {home,dir}=rig();writeFileSync(join(dir,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'selected-secret'}}));
 let allowed=true;const request=vi.fn(async()=>{allowed=false;return new Response(JSON.stringify({data:[{id:'private-model'}]}));});
 await expect(refreshNativeModels({cli:'claude-code',directory:dir,home,environment:{},authorized:()=>allowed,request:request as never})).rejects.toThrow();
 for(const response of [new Response('{"data":[{"id":"must-not-accept"}]}',{status:401}),new Response('{"data":{}}'),new Response('{"data":[]}')]){
  await expect(refreshNativeModels({cli:'claude-code',directory:dir,home,environment:{},request:async()=>response})).rejects.toThrow();
 }
});

it("a changed Claude credential file during the vendor wait cannot publish the previous account",async()=>{
 const {home,dir}=rig(),file=join(dir,".credentials.json");writeFileSync(file,JSON.stringify({claudeAiOauth:{accessToken:"first"}}));
 await expect(refreshNativeModels({cli:"claude-code",directory:dir,home,environment:{},request:async()=>{writeFileSync(file,JSON.stringify({claudeAiOauth:{accessToken:"second"}}));return new Response(JSON.stringify({data:[{id:"prior-account"}]}));}})).rejects.toThrow(/account changed/);
});
it.each([
 ['grok',['--no-auto-update','models']],['opencode',['models']],['antigravity',['models']],['kiro-cli',['chat','--list-models','--format','json']],
] as const)('native %s uses only its registered listing command, on the selected computer',async(cli,args)=>{
 const run=vi.fn(async()=>({ok:true,text:'{"models":[{"id":"model-new","name":"Latest"}]}'}));
 const result=await refreshNativeModels({cli,environment:{},find:async()=>({path:'C:\\cli.exe',command:'C:\\cli.exe',args:[]}),run});
 expect(result).toEqual({models:[{id:'model-new',name:'Latest'}],source:'cli-list'});expect(run).toHaveBeenCalledWith(expect.anything(),[...args],{});
});
