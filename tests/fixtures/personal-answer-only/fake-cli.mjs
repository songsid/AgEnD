// Inert Codex-shaped process. It only talks to the product's loopback setup endpoint.
import {readFileSync,existsSync} from "node:fs";
import {join} from "node:path";
import {WebSocket} from "ws";
const mode=process.argv[2],args=process.argv.slice(3);
if(process.env.OPENAI_API_KEY!=="agend-inert-answer-only-check"){
 const auth=JSON.parse(readFileSync(join(process.env.CODEX_HOME,"auth.json"),"utf8"));
 if(auth.auth_mode!=="chatgpt"||auth.tokens.account_id!=="agend-inert-answer-only-check"||auth.tokens.refresh_token!=="")process.exit(9);
}else if(existsSync(join(process.env.CODEX_HOME,"auth.json")))process.exit(9);
const prefix="openai_base_url=",argument=args.find(s=>s.startsWith(prefix));
const origin=JSON.parse(argument.slice(prefix.length));
if(!origin.startsWith("http://127.0.0.1:"))process.exit(10);
const model=JSON.parse(readFileSync(join(process.env.CODEX_HOME,"answer-only-model.json"),"utf8")).models[0].slug;
const body={model:mode==="wrong-model"?"wrong-model":model,...(mode==="missing-tools"?{}:{tools:(mode==="tools"||mode==="chatgpt-tools"&&!process.env.OPENAI_API_KEY)?[{type:"function",name:"exec_command"}]:[]})};
if(mode.startsWith("ws-")){
 const ws=new WebSocket(origin.replace(/^http/,"ws")+"/responses");
 await new Promise((resolve,reject)=>{ws.once("error",reject);ws.once("open",resolve);});
 const prewarm=mode==="ws-prewarm-only";
 const result=new Promise(resolve=>{ws.on("message",data=>{if(JSON.parse(data.toString()).type==="response.completed")resolve(true);});ws.once("close",()=>resolve(false));});
 ws.send(JSON.stringify({type:"response.create",...body,tools:mode==="ws-tools"?[{type:"function",name:"exec_command"}]:[],...(prewarm?{generate:false}:{})}));
 if(!await result)process.exit(11);ws.close();
}else{
 const response=await fetch(origin+"/responses",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
 if(!response.ok)process.exit(11);
 const stream=await response.text();if(!stream.includes("AGEND_ANSWER_ONLY_READY"))process.exit(12);
}
for(const event of [{type:"turn.started"},...(mode==="action-event"?[{type:"item.completed",item:{type:"command_execution",command:"refused"}}]:[]),
 {type:"item.completed",item:{type:"agent_message",text:"AGEND_ANSWER_ONLY_READY"}},{type:"turn.completed"}])process.stdout.write(JSON.stringify(event)+"\n");
