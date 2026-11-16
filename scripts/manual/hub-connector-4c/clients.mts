/** Native remote-MCP OAuth and a few real model calls. Only copied account auth enters an owned, disposable home. */
import {spawn,spawnSync,execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,copyFileSync,chmodSync,statSync,rmSync,realpathSync} from "node:fs";
import {resolve,join,dirname} from "node:path";
import {request} from "node:https";
import {createOwnedPki} from "./rig.mjs";

if(process.platform!=="linux")throw new Error("Headless Linux only");
const out=resolve(process.env.OUT||".artifacts/hub-connector-4c/clients");mkdirSync(out,{recursive:true,mode:0o700});
const scratch=mkdtempSync(join(out,"owned-"));chmodSync(scratch,0o700);
const home=process.env.HOME!,source={codex:join(process.env.CODEX_HOME||join(home,".codex"),"auth.json"),claude:join(home,".claude/.credentials.json")};
const before=Object.fromEntries(Object.entries(source).map(([k,p])=>[k,[statSync(p).size,statSync(p).mtimeMs]]));
const binaries={codex:realpathSync(process.env.CODEX_BIN||join(home,".local/bin/codex")),claude:realpathSync(process.env.CLAUDE_BIN||join(home,".local/bin/claude"))};
const containers=new Set<string>(),results:any[]=[],network=`cairn-m3240-${process.pid}`,serverName=network+"-server";
let hub:{origin:string;personKey:string}|undefined,publishedPort:number|undefined;
const cleanEnv={...process.env};for(const key of["DISPLAY","WAYLAND_DISPLAY","WSL_INTEROP","BROWSER","CHROME"])delete cleanEnv[key];
const file=(name:string,value:string)=>writeFileSync(join(scratch,name),value,{mode:0o600});
let serial=0;
function run(cli:"codex"|"claude",args:string[],input?:string){
 const name=`cairn-m3240-${process.pid}-${++serial}`;containers.add(name);
 const env:Record<string,string>={HOME:`/trial/home-${cli}`,CODEX_HOME:"/trial/codex",CLAUDE_CONFIG_DIR:"/trial/claude",NODE_EXTRA_CA_CERTS:"/trial/pki/ca.pem",SSL_CERT_FILE:"/trial/ca-bundle.pem",NO_PROXY:"hub.example.com,127.0.0.1,localhost",no_proxy:"hub.example.com,127.0.0.1,localhost",DISABLE_AUTOUPDATER:"1",NO_UPDATE_NOTIFIER:"1",CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",BROWSER:"/bin/false"};
 for(const key of["HTTPS_PROXY","HTTP_PROXY","ALL_PROXY"])if(process.env[key])env[key]=process.env[key]!;
 const mount=cli==="codex"?dirname(binaries.codex):binaries.claude,executable=cli==="codex"?"/opt/codex-bin/codex":"/opt/claude";
 const terminal=cli==="claude"&&args[0]==="mcp"&&args[1]==="login";
 const docker=["run","--rm","-i",...(terminal?["-t"]:[]),"--name",name,"--network",network,"--user",`${process.getuid!()}:${process.getgid!()}`,"--cap-drop","ALL","--security-opt","no-new-privileges", "--mount",`type=bind,src=${scratch},dst=/trial`,"--mount",`type=bind,src=${mount},dst=${cli==="codex"?"/opt/codex-bin":"/opt/claude"},readonly`,"--workdir","/trial/workspace",...Object.entries(env).flatMap(([k,v])=>["-e",`${k}=${v}`]),"node:22-bookworm",executable,...args];
 // Claude's no-browser login explicitly requires a terminal. This private PTY has
 // no tmux pane, graphical terminal or desktop process; it is only OAuth text I/O.
 const started=Date.now(),child=terminal?spawn("python3",["-c","import os,pty,sys;sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))","docker",...docker],{env:cleanEnv,stdio:["pipe","pipe","pipe"]}):spawn("docker",docker,{env:cleanEnv,stdio:["pipe","pipe","pipe"]});let stdout="",stderr="",timedOut=false;
 child.stdout.on("data",chunk=>{stdout+=chunk;});child.stderr.on("data",chunk=>{stderr+=chunk;});
 const timer=setTimeout(()=>{timedOut=true;execFileSync("docker",["kill",name],{stdio:"ignore"});},300_000);timer.unref();
 const done=new Promise<{exit:number|null;seconds:number;timedOut:boolean;stdout:string;stderr:string}>(yes=>child.once("close",exit=>{clearTimeout(timer);containers.delete(name);yes({exit,seconds:(Date.now()-started)/1000,timedOut,stdout,stderr});}));
 if(input!==undefined)child.stdin.end(input);
 return{child,done,output:()=>stdout+"\n"+stderr};
}
async function httpsJson(path:string,method="GET",value?:unknown,cookie?:{cookie:string;csrf:string},bearer?:string){
 const url=new URL(path,hub!.origin);if(url.origin!==hub!.origin)throw new Error("Foreign authorization destination");
 return new Promise<{status:number;headers:import("node:http").IncomingHttpHeaders;json:any;text:string}>((yes,no)=>{
  const req=request(url,{method,hostname:"127.0.0.1",port:publishedPort,servername:"hub.example.com",ca:readFileSync(join(scratch,"pki/ca.pem")),headers:{Host:url.host,Origin:hub!.origin,Accept:"application/json, text/event-stream",...(bearer?{Authorization:`Bearer ${bearer}`}:{}) ,...(cookie?{Cookie:cookie.cookie,"X-AgEnD-Hub-CSRF":cookie.csrf}:{}),...(value===undefined?{}:{"Content-Type":value instanceof URLSearchParams?"application/x-www-form-urlencoded":"application/json"})}},res=>{let text="";res.on("data",c=>{text+=c;});res.on("end",()=>{let json;try{json=JSON.parse(text);}catch{}yes({status:res.statusCode!,headers:res.headers,json,text});});});req.on("error",no);req.end(value===undefined?undefined:value instanceof URLSearchParams?value.toString():JSON.stringify(value));
 });
}
const expect=(ok:unknown,reason:string)=>{if(!ok)throw new Error(reason);};
const redact=(s:string)=>s.replace(/https?:\/\/[^\s"<>]+/g,"[URL withheld]").replace(/[A-Za-z0-9_-]{43,}/g,"[opaque value withheld]");
function completedTools(raw:string,cli:"codex"|"claude"){
 const used=new Set<string>(),calls=new Map<string,string>();
 for(const line of raw.split("\n")){let event:any;try{event=JSON.parse(line);}catch{continue;}
  if(cli==="codex"&&event.type==="item.completed"&&event.item?.type==="mcp_tool_call"&&event.item.server==="agend_hub"&&event.item.status==="completed")used.add(event.item.tool);
  if(cli==="claude")for(const block of event.message?.content||[]){
   if(block.type==="tool_use"&&block.name?.startsWith("mcp__agend_hub__"))calls.set(block.id,block.name.slice("mcp__agend_hub__".length));
   if(block.type==="tool_result"&&!block.is_error&&calls.has(block.tool_use_id))used.add(calls.get(block.tool_use_id)!);
  }
 }
 return used;
}
try{
 for(const name of["workspace","codex","claude","home-codex","home-claude"])mkdirSync(join(scratch,name),{mode:0o700});
 for(const [cli,p]of Object.entries(source)){const destination=join(scratch,cli,cli==="codex"?"auth.json":".credentials.json");copyFileSync(p,destination);chmodSync(destination,0o600);}
 const pki=createOwnedPki(join(scratch,"pki"));file("ca-bundle.pem",readFileSync("/etc/ssl/certs/ca-certificates.crt","utf8")+readFileSync(pki.ca,"utf8"));
 execFileSync("docker",["network","create",network],{stdio:"ignore"});
 execFileSync("docker",["run","-d","--name",serverName,"--network",network,"--network-alias","hub.example.com","--user",`${process.getuid!()}:${process.getgid!()}`,"--cap-drop","ALL","--security-opt","no-new-privileges","-p","127.0.0.1::18443","--mount",`type=bind,src=${process.cwd()},dst=/repo,readonly`,"--mount",`type=bind,src=${resolve("../../node_modules")},dst=/repo/node_modules,readonly`,"--mount",`type=bind,src=${scratch},dst=/trial`,"--workdir","/repo","node:22-bookworm","node","--import","tsx","scripts/manual/hub-connector-4c/client-server.mts"],{stdio:"ignore"});containers.add(serverName);
 for(let i=0;i<200;i++){try{hub=JSON.parse(readFileSync(join(scratch,"server-ready.json"),"utf8"));break;}catch{}await new Promise(yes=>setTimeout(yes,50));}
 expect(hub,"Owned server container did not become ready");publishedPort=Number(execFileSync("docker",["port",serverName,"18443/tcp"],{encoding:"utf8"}).trim().split(":").at(-1));
 const address=hub.origin+"/mcp",names=["hub_room_list","hub_room_members","hub_room_read","hub_room_post","hub_agent_list","hub_ask","hub_ask_result","hub_people_search"];
 file("codex/config.toml",`model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\nservice_tier = "standard"\napproval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\ncli_auth_credentials_store = "file"\nmcp_oauth_credentials_store = "file"\n[features]\napps = false\nplugins = false\n[mcp_servers.agend_hub]\nurl = ${JSON.stringify(address)}\nstartup_timeout_sec = 20\ndefault_tools_approval_mode = "approve"\n`);
 file("mcp.json",JSON.stringify({mcpServers:{agend_hub:{type:"http",url:address}}}));
 file("claude-settings.json",JSON.stringify({permissions:{allow:names.map(n=>`mcp__agend_hub__${n}`)}}));
 const signIn=await httpsJson("/hub/v1/session","POST",{login:"casey",password:"pw-casey"});expect(signIn.status===200,"HTTPS person sign-in failed");
 const browser={cookie:String(signIn.headers["set-cookie"]?.[0]).split(";")[0]!,csrf:signIn.json.csrf};
 if(process.env.PREFLIGHT_ONLY){
  const verifier="v".repeat(43),client=await httpsJson("/mcp/oauth/register","POST",{client_name:"Diagnostic app",redirect_uris:[hub!.origin+"/owned-callback"]});
  const query=new URLSearchParams({client_id:client.json.client_id,redirect_uri:hub!.origin+"/owned-callback",response_type:"code",resource:address,code_challenge_method:"S256",code_challenge:createHash("sha256").update(verifier).digest("base64url")});
  const pending=await httpsJson("/mcp/oauth/authorize?"+query),id=new URL(String(pending.headers.location),hub!.origin).searchParams.get("request");
  const approved=await httpsJson("/hub/v1/mcp/consent","POST",{request:id,scopes:["rooms:read","rooms:post","agents:ask"]},browser),code=new URL(approved.json.location).searchParams.get("code");
  const token=await httpsJson("/mcp/oauth/token","POST",new URLSearchParams({grant_type:"authorization_code",client_id:client.json.client_id,code:code!,code_verifier:verifier,redirect_uri:hub!.origin+"/owned-callback",resource:address}));expect(token.status===200,"Diagnostic grant failed");
  const init=await httpsJson("/mcp","POST",{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"diagnostic",version:"1"}}},undefined,token.json.access_token);expect(init.status===200,"Diagnostic initialize failed");
  const ready=JSON.parse(readFileSync(join(scratch,"server-ready.json"),"utf8"));
  const asked=await httpsJson("/mcp","POST",{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"hub_ask",arguments:{agent:ready.exposureId,text:"Diagnostic fixture question"}}},undefined,token.json.access_token);console.log("diagnostic ask",asked.status);
  await new Promise(yes=>setTimeout(yes,1000));
  const askedBody=JSON.parse(asked.json.result.content[0].text),answer=await httpsJson("/mcp","POST",{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"hub_ask_result",arguments:{id:askedBody.id}}},undefined,token.json.access_token);
  expect(JSON.stringify(answer.json).includes("LARCH-42"),"Diagnostic answer not returned");
  writeFileSync(join(out,"diagnostic.json"),JSON.stringify({ask:asked.status,result:answer.status,answerSeen:true,modelCalls:0},null,2)+"\n");
  console.log("diagnostic answer PASS; no model calls");
 }
 if(!process.env.PREFLIGHT_ONLY){for(const cli of(["codex","claude"] as const).filter(cli=>!process.env.CLIENTS||process.env.CLIENTS.split(",").includes(cli))){
  const version=await run(cli,["--version"],"").done;expect(version.exit===0,cli+" container binary unavailable");
  if(cli==="claude"){const added=await run(cli,["mcp","add","--scope","user","--transport","http","agend_hub",address],"").done;expect(added.exit===0,"Claude URL registration failed");}
  const login=run(cli,["mcp","login","--no-browser","agend_hub"]);let authorization:string|undefined;
  for(let i=0;i<300;i++){authorization=login.output().match(/https?:\/\/[^\s<>"\x1b]+\/mcp\/oauth\/authorize\?[^\s<>"\x1b]+/)?.[0];if(authorization)break;await new Promise(yes=>setTimeout(yes,50));}
  if(!authorization){writeFileSync(join(out,cli+"-login.private.log"),login.output());throw new Error(cli+" did not publish an OAuth URL");}
  const authorize=await httpsJson(authorization);expect(authorize.status===302,"Native OAuth authorization refused");
  const pending=new URL(String(authorize.headers.location),hub.origin).searchParams.get("request")!;
  const preview=await httpsJson("/hub/v1/mcp/consent?request="+encodeURIComponent(pending),"GET",undefined,browser);expect(preview.status===200&&preview.json.scopes.length===3,"Native consent preview refused");
  const consent=await httpsJson("/hub/v1/mcp/consent","POST",{request:pending,scopes:preview.json.scopes},browser);expect(consent.status===200,"Native consent failed");
  login.child.stdin.end(consent.json.location+"\n");const authenticated=await login.done;
  writeFileSync(join(out,cli+"-login.private.log"),authenticated.stdout+"\n"+authenticated.stderr);expect(authenticated.exit===0,cli+" native OAuth login failed");
  console.log(JSON.stringify({cli,stage:"native OAuth",exit:authenticated.exit,seconds:authenticated.seconds,clientName:preview.json.name}));
  const prompt=`Use only the eight agend_hub MCP tools. This is an owned fixture Hub, not a live organization. List my rooms; inspect Project members and recent messages; post exactly "Connector trial complete." to Project with no mentions; list my allowed agents; ask Project helper "What is the trial code and meeting?"; read its answer using hub_ask_result with the returned id (retry that result read if still working); search people for Riley. Use all eight named tools once where possible. Return only compact JSON with room, agent, trial code, meeting and the colleague found. Do not use shell, files, web, skills or any other tools.`;
  const args=cli==="codex"?["exec","--strict-config","--ignore-rules","--json","--ephemeral","--skip-git-repo-check","-C","/trial/workspace","-"]:["-p","--verbose","--output-format","stream-json","--setting-sources","","--settings","/trial/claude-settings.json","--permission-prompts","none","--permission-mode","dontAsk","--tools","","--disable-slash-commands","--strict-mcp-config","--mcp-config","/trial/mcp.json","--no-session-persistence","--no-chrome","--model","sonnet"];
  const answer=await run(cli,args,prompt).done;writeFileSync(join(out,cli+"-model.private.jsonl"),answer.stdout);writeFileSync(join(out,cli+"-stderr.private.log"),answer.stderr);
  const completed=completedTools(answer.stdout,cli),used=names.filter(name=>completed.has(name));const entry={cli,version:version.stdout.trim(),oauth:{exit:authenticated.exit,seconds:authenticated.seconds,clientName:preview.json.name},model:{exit:answer.exit,seconds:answer.seconds,timedOut:answer.timedOut,tools:used,answerSeen:answer.stdout.includes("LARCH-42")},addressOnly:true,noAgendInstalled:true};results.push(entry);
  writeFileSync(join(out,"partial.json"),JSON.stringify({results},null,2)+"\n");console.log(JSON.stringify(entry));
  expect(answer.exit===0&&!answer.timedOut&&entry.model.answerSeen&&used.length===8,cli+" actual remote-tool journey failed");
 }
 await new Promise(yes=>setTimeout(yes,150));const stats=JSON.parse(readFileSync(join(scratch,"server-receipt.json"),"utf8"));expect(stats.companyPersonBound,"Native apps did not bind the company person");
 expect(stats.inertDirectAnswers===results.length&&!stats.failures.length,"Inert direct-answer delivery count failed");
 const authOriginalUnchanged=Object.fromEntries(Object.entries(source).map(([k,p])=>[k,JSON.stringify(before[k])===JSON.stringify([statSync(p).size,statSync(p).mtimeMs])]));expect(Object.values(authOriginalUnchanged).every(Boolean),"Source account auth changed");
 writeFileSync(join(out,"receipt.json"),JSON.stringify({results,companyPersonBound:true,inertDirectAnswers:stats.inertDirectAnswers,authOriginalUnchanged,scope:"Native Linux Claude Code and Codex, their no-browser OAuth and real short model calls; direct HTTPS Hub, rig-only CA/DNS, owned SQLite/audit and inert directory/agent. No AgEnD installed in client containers, no desktop window, live Hub/Fleet/AD or pane."},null,2)+"\n");
 }
}catch(error){writeFileSync(join(out,"failure.json"),JSON.stringify({message:redact(error instanceof Error?error.message:String(error)),results},null,2)+"\n");throw error;}
finally{
 {const log=spawnSync("docker",["logs",serverName],{encoding:"utf8"});writeFileSync(join(out,"server.private.log"),String(log.stdout||"")+String(log.stderr||""));}
 try{writeFileSync(join(out,"server-state.json"),execFileSync("docker",["inspect","--format","{{json .State}}",serverName],{encoding:"utf8"}));}catch{}
 for(const name of containers)try{execFileSync("docker",["rm","-f",name],{stdio:"ignore"});}catch{}try{execFileSync("docker",["network","rm",network],{stdio:"ignore"});}catch{}rmSync(scratch,{recursive:true,force:true});
}
