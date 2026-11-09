/** M-2779 main twin: display-only shared component fixture in the real main Settings shell. Actual Fleet Settings and its Settings confirmation gate, no Hub request until local approval.
 * REPO=$PWD OUT=<owned-output> PW_DIR=<private-playwright> CHROME=<binary> node --import tsx <this-file>
 * MATRIX=full default. The timeout leg advances only the browser clock, never the server authorization deadline.
 */
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,chmodSync,rmSync,existsSync} from "node:fs";
import {resolve,join,dirname} from "node:path";
import {execFileSync} from "node:child_process";
const repo=resolve(process.env.REPO!),out=resolve(process.env.OUT!);mkdirSync(out,{recursive:true});
const home=mkdtempSync(join(out,"owned-")),bin=join(home,"bin");mkdirSync(bin);
process.env.AGEND_HOME=home;process.env.TMUX_TMPDIR=join(home,"tmux");
for(const k of ["OPENAI_API_KEY","ANTHROPIC_API_KEY","DISCORD_BOT_TOKEN","TELEGRAM_BOT_TOKEN"])delete process.env[k];
for(const name of ["tmux","agend","claude","codex","kiro-cli"]){const file=join(bin,name);writeFileSync(file,`#!${process.execPath}\nprocess.exit(97)\n`);chmodSync(file,0o755)}
process.env.PATH=[bin,dirname(process.execPath),"/usr/bin","/bin"].join(":");process.env.AGEND_TMUX_BIN=join(bin,"tmux");
const {bootFixture,matrix,caseName}=await import("../smoke-fixture/index.mts");
const r:any={checks:[],shots:[],errors:[],cases:[],scope:"Real main Fleet Settings shell, synthetic client-store pending row for the shared display component only. Main has no company-join backend; no such authority/action claimed. No API reply stubs, no native/model/accounts/directory/pilot."};
const check=(name:string,ok:boolean)=>{r.checks.push({name,ok});if(!ok)throw Error(name)};let fx:any;
try{
 fx=await bootFixture({port:Number(process.env.HP??55810),instances:1,classic:false});
 for(const c of matrix())for(const before of [true,false]){
  const tag=caseName(c)+'-'+(before?'before':'after'),{ctx,page:p}=await fx.page(c,{path:'/settings/advanced'});p.on('pageerror',(e:any)=>r.errors.push(e.message));
  await ctx.route('**/*',(route:any)=>{const u=new URL(route.request().url());if(u.origin!==fx.base)return route.abort();if(before&&u.pathname==='/assets/app-shell.js')return route.fulfill({contentType:'application/javascript',body:execFileSync('git',['show','e5bef1cb2c21d57f8397cd592958340445202b6c:src/ui/shared/app-shell.js'],{cwd:repo})});return route.continue()});await p.reload();
  await p.evaluate(async()=>{const {appStore}=await import('/assets/app-store.js');appStore.set({pendingChanges:[{id:'preview-only',label:'Display fixture',state:'pending',summary:['Connect this Fleet to Hub https://hub.example.test using your company account. Agent sharing stays separate.'],deadline:Date.now()+60000,confirmation:{kind:'host_cli',code:'display-preview-only'}}]})});
  await p.locator('.pending-summary').waitFor();const text=await p.locator('.pending-summary').innerText();check(tag+' exact component text',text===(c.lang==='zh-TW'&&!before?'以公司帳號將這個 Fleet 連接到 Hub https://hub.example.test。分享 Agent 需另外選擇。':'Connect this Fleet to Hub https://hub.example.test using your company account. Agent sharing stays separate.'));
  await p.locator('.pending-card').scrollIntoViewIfNeeded();await p.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())))});await p.screenshot({path:join(out,tag+'.png')});r.shots.push(tag+'.png');check(tag+' no page overflow',await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));r.cases.push(tag);await ctx.close();
 }
 check('no script errors',r.errors.length===0);r.status='PASS';
}catch(e:any){r.status='FAIL';r.error=e.stack;process.exitCode=1}
finally{if(fx)await fx.close();rmSync(home,{recursive:true,force:true});r.cleaned=true;writeFileSync(join(out,'receipt.json'),JSON.stringify(r,null,2));console.log(JSON.stringify({status:r.status,shots:r.shots.length,checks:r.checks.length,error:r.error}))}
