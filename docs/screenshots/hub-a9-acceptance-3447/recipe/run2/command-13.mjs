const a=globalThis.a9,{request,createServer}=await import('node:http'),fs=await import('node:fs'),path=await import('node:path'),crypto=await import('node:crypto'),os=await import('node:os');
const {csrfTokenFor,tokenEpoch}=await import(process.env.REPO+'/src/web-session.ts');const {bindGatewayRequest}=await import(process.env.REPO+'/src/web-request-context.ts');
const m=a.security;const fm=m.fx.fm,base=m.fx.base,port=Number(new URL(base).port),cookies=await m.ctx.cookies(base),sc=cookies.find(c=>c.name.startsWith('agend_session')),sid=sc.value;
function raw(targetPort,method,url,headers={},body,localAddress){
 return new Promise((yes,no)=>{
  const req=request({host:'127.0.0.1',port:targetPort,method,path:url,headers,localAddress,agent:false},res=>{
   let t='';res.on('data',x=>t+=x);res.on('end',()=>{
    let b;try{b=JSON.parse(t)}catch{b={text:t.slice(0,100)}}
    yes({status:res.statusCode,body:b,cookie:(res.headers['set-cookie']?.[0]||'').split(';')[0]});
   });
  });
  req.setTimeout(5000,()=>req.destroy(Error('owned request timed out')));req.on('error',no);req.end(body);
 });
}
const h={Host:new URL(base).host,Origin:base,'Content-Type':'application/json',Cookie:sc.name+'='+sid,'x-agend-csrf':csrfTokenFor(sid)},prefix='/api/settings/hub/setup';
const hashState=()=>{const files=['fleet.yaml','hub/init-manifest.json','hub/keys/identity.json','hub/keys/tls-key.pem','hub/keys/tls-cert.pem'];return{files:Object.fromEntries(files.map(f=>[f,fs.existsSync(path.join(fm.dataDir,f))?crypto.createHash('sha256').update(fs.readFileSync(path.join(fm.dataDir,f))).digest('hex'):null])),drafts:fs.readdirSync(fm.dataDir).filter(x=>x.startsWith('.hub-browser-')),controller:!!fm.hubSetupController}};
const result={positive:[],refused:[],remote:[]};
const inspect=await raw(port,'GET',prefix,h);a.check(inspect.status===200,'D3 host cannot inspect setup');
for(const action of ['prepare','test','commit']){const q=await raw(port,'POST',prefix+'/'+action,h,'{}');a.check(q.status===400,'Host control not reaching setup validation '+action);result.positive.push({action,status:q.status,code:q.body.error})}
const code=fm.issueDashboardLogin().display,login=await raw(port,'POST','/auth/login',{'Content-Type':'application/json',Origin:base},JSON.stringify({code})),otherId=login.cookie.split('=')[1];a.check(login.status===200,'Ordinary nonhost login failed');
const guest=fm.webSessions.create({tier:'guest',surface:'local',label:'Synthetic guest',owner:{adapterId:'test',userId:'guest'},tokenEpoch:tokenEpoch(fm.webToken)});
const before=hashState();const cases=[['non-host admin',{Cookie:login.cookie,'x-agend-csrf':csrfTokenFor(otherId)}],['guest',{Cookie:sc.name+'='+guest.sessionId,'x-agend-csrf':csrfTokenFor(guest.sessionId)}],['forwarded',{'x-forwarded-for':'198.51.100.1'}],['tunnel',{'forwarded':'for=198.51.100.2;proto=https'}],['public hostname',{Host:'public.example.test',Origin:'https://public.example.test'}]];
for(const [name,extra]of cases)for(const action of ['prepare','test','commit']){const q=await raw(port,'POST',prefix+'/'+action,{...h,...extra},'{}');a.check([401,403].includes(q.status),name+' was not refused '+action);result.refused.push({name,action,status:q.status,code:q.body.error})}
const ip=Object.values(os.networkInterfaces()).flat().find(x=>x?.family==='IPv4'&&!x.internal)?.address;
if(ip)for(const action of ['prepare','test','commit']){const q=await raw(port,'POST',prefix+'/'+action,h,'{}',ip);a.check([401,403].includes(q.status),'Nonloopback TCP peer admitted');result.remote.push({action,status:q.status,code:q.body.error,sourceKind:'actual assigned non-loopback local TCP source to owned loopback listener'})}
else result.remote.push({status:'NOT_RUN',reason:'No assigned non-loopback local source'});
const gateway=createServer((req,res)=>{bindGatewayRequest(req,{surface:'gateway',exposureId:'e'.repeat(32),expectedOrigin:base,isCurrent:()=>true});void fm.dispatchWebHttp(req,res,port)});await new Promise(yes=>gateway.listen(0,'127.0.0.1',yes));
try{for(const action of ['prepare','test','commit']){const q=await raw(gateway.address().port,'POST',prefix+'/'+action,h,'{}');a.check([401,403].includes(q.status),'Gateway host-cookie replay admitted');result.refused.push({name:'public gateway context with host-cookie replay',action,status:q.status,code:q.body.error})}}finally{gateway.closeAllConnections();await new Promise(yes=>gateway.close(yes))}
const after=hashState();a.check(JSON.stringify(before)===JSON.stringify(after),'Refused requests changed setup state');result.stateUnchanged=true;result.fixtureBoundary='Real routes/D3 auth/TCP. Guest is fixture session, public link uses production bound gateway context on an owned forwarding listener; no tunnel process or external remote host.';
a.receipt.security=result;return result;
