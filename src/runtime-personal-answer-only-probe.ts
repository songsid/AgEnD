/** A local, inert Responses endpoint observes the effective catalog without using any account or model. */
import {createServer} from "node:http";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {execFile} from "./child-process.js";
import {PersonalAgentAnswerReader} from "./runtime-personal-answer.js";
import {ANSWER_ONLY_CATALOG_FILE,ANSWER_ONLY_PROBE_TEXT,assertAnswerOnlyRequest} from "./runtime-personal-answer-only.js";
import type {PersonalProfilePlan} from "./runtime-personal-profile.js";
import type {NativeCliExecutable} from "./windows-cli-worker.js";

export async function checkAnswerOnlyCatalog(binary:NativeCliExecutable,plan:PersonalProfilePlan,environment:NodeJS.ProcessEnv):Promise<void>{
  if(!plan.answerOnly||!plan.environment.CODEX_HOME)throw Error("Answer only profile missing");
  const model=JSON.parse(plan.files[ANSWER_ONLY_CATALOG_FILE]).models?.[0]?.slug;
  if(typeof model!=="string")throw Error("Answer only model missing");
  // The portable builder imports Runtime metadata before installing external dependencies.
  const {WebSocketServer}=await import("ws");
  const privateHome=mkdtempSync(join(plan.cwd,".answer-only-check-"));
  let observed=false,refused=false,requests=0;
  const events=()=>{
    const item={id:"answer-only-probe-message",type:"message",role:"assistant",content:[{type:"output_text",text:ANSWER_ONLY_PROBE_TEXT}]};
    return [{type:"response.created",response:{id:"answer-only-probe",status:"in_progress",output:[]}},
      {type:"response.output_item.added",output_index:0,item:{...item,content:[]}},
      {type:"response.output_text.delta",item_id:item.id,output_index:0,content_index:0,delta:ANSWER_ONLY_PROBE_TEXT},
      {type:"response.output_item.done",output_index:0,item},
      {type:"response.completed",response:{id:"answer-only-probe",status:"completed",output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
  };
  const inspect=(value:unknown)=>{if(++requests>2)throw Error("Too many local check requests");assertAnswerOnlyRequest(value,model);if((value as {generate?:unknown}).generate!==false)observed=true;};
  const server=createServer(async(req,res)=>{
    // Synthetic ChatGPT sessions may read account metadata; nothing is supplied and no tool is implied.
    if(req.method==="GET"){res.writeHead(404);res.end();return;}
    try{
      if(req.method!=="POST"||!["/v1/responses","/v1/codex/responses"].includes(req.url??""))throw Error("Unexpected local probe request");
      let bytes=0;const chunks:Buffer[]=[];
      for await(const chunk of req){bytes+=chunk.length;if(bytes>512*1024)throw Error("Probe request too large");chunks.push(chunk);}
      inspect(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-store"});
      for(const event of events())res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    }catch{refused=true;if(!res.headersSent)res.writeHead(400);res.end();}
  });
  const sockets=new WebSocketServer({noServer:true,maxPayload:512*1024});
  server.on("upgrade",(req,socket,head)=>{
    if(!["/v1/responses","/v1/codex/responses"].includes(req.url??"")){refused=true;socket.destroy();return;}
    sockets.handleUpgrade(req,socket,head,ws=>{
      ws.on("error",()=>{refused=true;});
      ws.on("message",data=>{try{
        const value=JSON.parse(data.toString());if(value.type!=="response.create")throw Error();inspect(value);
        for(const event of value.generate===false? [{type:"response.completed",response:{id:"answer-only-prewarm",status:"completed",output:[]}}] : events())ws.send(JSON.stringify(event));
      }catch{refused=true;ws.close(1008);}});
    });
  });
  try{
    const original=JSON.stringify(plan.environment.CODEX_HOME).slice(1,-1),replacement=JSON.stringify(privateHome).slice(1,-1);
    for(const name of ["config.toml",ANSWER_ONLY_CATALOG_FILE])writeFileSync(join(privateHome,name),plan.files[name].replaceAll(original,replacement),{mode:0o600,flag:"wx"});
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
    const address=server.address();if(!address||typeof address==="string")throw Error("Local check unavailable");
    // Both built-in authentication modes must produce the same empty catalog. These are synthetic,
    // local-only credentials; the person's access token is never copied or sent to the setup endpoint.
    for(const mode of ["apikey","chatgpt"] as const){
      observed=false;requests=0;
      const env:NodeJS.ProcessEnv={HOME:privateHome,USERPROFILE:privateHome,CODEX_HOME:privateHome};
      for(const [key,value] of Object.entries(environment))if(["PATH","SYSTEMROOT","WINDIR","TEMP","TMP","PATHEXT","COMSPEC"].includes(key.toUpperCase()))env[key]=value;
      if(mode==="apikey")env.OPENAI_API_KEY="agend-inert-answer-only-check";
      else {
        const claims={exp:Math.floor(Date.now()/1000)+3600,"https://api.openai.com/auth":{chatgpt_account_id:"agend-inert-answer-only-check"}};
        const token=`${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.inert`;
        writeFileSync(join(privateHome,"auth.json"),JSON.stringify({auth_mode:"chatgpt",tokens:{access_token:token,id_token:token,refresh_token:"",account_id:"agend-inert-answer-only-check"},last_refresh:new Date().toISOString()}),{mode:0o600,flag:"wx"});
      }
      // The built-in endpoint keys are verified on rust-v0.167.0 (086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a).
      // The local check intentionally inherits no proxy or custom CA: only the real inference turn needs those.
      const args=[...binary.args,...plan.args.slice(0,-1),
        "-c",`openai_base_url=${JSON.stringify(`http://127.0.0.1:${address.port}/v1`)}`,
        "-c",`chatgpt_base_url=${JSON.stringify(`http://127.0.0.1:${address.port}/v1`)}`,ANSWER_ONLY_PROBE_TEXT];
      const stdout=await new Promise<string>((resolve,reject)=>{
        const child=execFile(binary.command,args,{cwd:plan.cwd,env,windowsHide:true,shell:false,timeout:15_000,maxBuffer:1024*1024,encoding:"utf8"},(error,out)=>error?reject(Error("Answer only local check failed")):resolve(out));
        child.stdin?.end();
      });
      const reader=new PersonalAgentAnswerReader("codex",{answerOnly:true});reader.write(Buffer.from(stdout));const result=reader.finish(0);
      if(!observed||refused||!result.ok||result.answer!==ANSWER_ONLY_PROBE_TEXT)throw Error("Answer only effective catalog was not proved empty");
    }
  }finally{
    for(const ws of sockets.clients)ws.terminate();sockets.close();
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    rmSync(privateHome,{recursive:true,force:true});
  }
}
