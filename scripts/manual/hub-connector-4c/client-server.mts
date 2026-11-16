/** Docker-Desktop-compatible owned HTTPS fixture; no production route or control backdoor. */
import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {startOwnedHub} from "./rig.mjs";
const at=(name:string)=>join("/trial",name),directory=at("pki");
const pki={directory,ca:join(directory,"ca.pem"),cert:join(directory,"server.pem"),key:join(directory,"server.key")};
const hub=await startOwnedHub(pki,{host:"0.0.0.0",port:18443});await hub.setEnabled(true);
writeFileSync(at("server-ready.json"),JSON.stringify({origin:hub.origin,personKey:hub.personKey,roomId:hub.roomId,exposureId:hub.exposureId}));
const snapshot=()=>{const apps=hub.hub.db.prepare("SELECT person,state FROM hub_mcp_apps").all() as {person:string;state:string}[];
 writeFileSync(at("server-receipt.json"),JSON.stringify({apps:apps.length,companyPersonBound:apps.length>0&&apps.every(a=>a.person===hub.personKey&&a.state==="active"),inertDirectAnswers:hub.deliveries.length,failures:hub.failures}));};
const timer=setInterval(snapshot,100);let closed=false;
async function close(){if(closed)return;closed=true;clearInterval(timer);snapshot();await hub.close();process.exit(0);}
process.once("SIGTERM",()=>void close());process.once("SIGINT",()=>void close());
