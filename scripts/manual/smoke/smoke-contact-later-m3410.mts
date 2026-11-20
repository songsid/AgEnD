// M-3410 acceptance: real web server/components, synthetic account/role state, no fleet start or vendor calls.
// Run headless in a network namespace with loopback only; set scratch HOME, REPO, PW_DIR, CHROME, OUT and a CJK-capable FONTCONFIG_FILE.
import {writeFileSync} from 'node:fs';
import {bootFixture} from '../smoke-fixture/index.mts';
const out=process.env.OUT!,fx=await bootFixture({port:48796,host:true,classic:false,roster:[{name:'helper',displayName:'Assistant',backend:'claude-code',status:'paused',general:true}]});
const fm=fx.fm,bot={id:'fake-bot',type:'discord',isConnected:()=>false},owner={adapterId:bot.id,userId:'fake-admin'};
fm.adapters.set(bot.id,bot);let verified=true,role=true;
fm.webAuthority=()=>verified?{authority:{kind:'web-verified',actor:{adapter_id:owner.adapterId,user_id:owner.userId}},refusal:null}:{authority:{kind:'none',actor:null},refusal:'not_authorized'};
fm.isFleetAdmin=(u:string,id:string)=>role&&u===owner.userId&&id===owner.adapterId;
const issue=fm.webLoginCodes.issue.bind(fm.webLoginCodes);fm.webLoginCodes.issue=(o:any)=>issue({...o,host:undefined,owner});
const {ClassicChannelManager}=await import('../../../src/classic-channel-manager.ts');
const rooms=['public-research','daily-summary','public-notes','release-notes'].map((instanceName,i)=>({instanceName,channelId:'fake-room-'+i,adapterId:bot.id,name:instanceName,backend:'claude-code',restrictedMode:false}));
writeFileSync(fx.dir+'/classicBot.yaml',JSON.stringify({channels:Object.fromEntries(rooms.map((r,i)=>['room'+i,r]))}));
fm.classicChannels=new ClassicChannelManager(fx.dir,fm.logger);fm.needsYouItems=()=>[];
const result:any={headless:true,network:'isolated loopback only',synthetic:true,cases:[]};
try{
 for(const [n,c] of [{device:'desk',theme:'dark',lang:'zh-TW'},{device:'phone',theme:'light',lang:'en'}].entries()){
  verified=true;role=true;
  const {ctx,page,csp}=await fx.page(c as any,{path:'/ui/needs',host:true});const errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(String(e)));
  await page.waitForSelector('details.n-suggestions',{state:'attached'});await page.locator('details.n-suggestions').evaluate((e:any)=>e.open=true);
  const stem=`${c.device}-${c.theme}-${c.lang}`;await page.screenshot({path:out+'/'+stem+'-before.png'});
  verified=false;
  const ack=page.waitForResponse((r:any)=>new URL(r.url()).pathname==='/ui/needs/ack',{timeout:10000});
  await page.getByRole('button',{name:c.lang==='en'?'Later':'稍後',exact:true}).first().click();const response=await ack;
  const remaining=fm.contactNeeds({platform:'discord',...owner,adapterId:owner.adapterId,userId:owner.userId}).filter((i:any)=>i.reason==='contact_restricted_suggestion').length;
  await page.waitForFunction((n:number)=>document.querySelectorAll('.contact-need').length===n,remaining,{timeout:10000});
  await page.screenshot({path:out+'/'+stem+'-success.png'});
  const entry:any={stem,status:response.status(),dismissed:fm.contactService().host.store.suggestionDismissed(rooms[n].instanceName),errors,csp:await csp()};
  verified=true;await page.reload();await page.waitForSelector('details.n-suggestions',{state:'attached'});await page.locator('details.n-suggestions').evaluate((e:any)=>e.open=true);
  verified=false;role=false;
  const denied=page.waitForResponse((r:any)=>new URL(r.url()).pathname==='/ui/needs/ack',{timeout:10000});
  await page.getByRole('button',{name:c.lang==='en'?'Later':'稍後',exact:true}).first().click();entry.deniedStatus=(await denied).status();
  await page.getByText(c.lang==='en'?'This account is not an administrator for this room. Sign in with that room’s administrator account, then try again.':'這個帳號不是該房間的管理員。請以該房間的管理員帳號登入後再試。',{exact:true}).waitFor();
  await page.waitForFunction(()=>{const e=document.querySelector('.toast.err');return !!e && Number(getComputedStyle(e).opacity)>0.99},null,{timeout:3000});
  entry.toastFits=await page.locator('.toast.err').last().evaluate((e:any)=>e.scrollWidth<=e.clientWidth && e.scrollHeight<=e.clientHeight);
  await page.screenshot({path:out+'/'+stem+'-refused.png'});result.cases.push(entry);await ctx.close();
 }
}finally{writeFileSync(out+'/fixed-results.json',JSON.stringify(result,null,2));await fx.close();}
process.exit(result.cases.some((r:any)=>r.status!==200||r.deniedStatus!==403||r.errors.length||r.csp.length||!r.toastFits)?1:0);
