import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchedulerDb } from "../src/scheduler/db.js";
import { FleetManager } from "../src/fleet-manager.js";
import { decisionListAnswer } from "../src/decision-list.js";
import { boardToolAction } from "../src/task-board-tool.js";
import { ListSchedulesArgs, ListDecisionsArgs, TaskBoardArgs } from "../src/outbound-schemas.js";
const owned: {dir:string;db:SchedulerDb}[]=[];
afterEach(()=>{for(const {dir,db} of owned.splice(0)){db.close();rmSync(dir,{recursive:true,force:true});}});
function rig(){const dir=mkdtempSync(join(tmpdir(),"compact-lists-"));const db=new SchedulerDb(join(dir,"db"));owned.push({dir,db});return db;}
const actor={kind:"instance",name:"dev"} as const;
describe("compact paged agent lists",()=>{
 it("decision id is a title until detail; titles page after existing visibility filters",()=>{
  const db=rig();for(let i=0;i<25;i++)db.createDecision({project_root:"/owned",scope:"project",title:`Rule ${i}`,content:"private long rule",created_by:"dev"});
  const all=db.listDecisions("/owned");const first=decisionListAnswer(all,{}) as any;
  expect(first.decisions).toHaveLength(20);expect(first.next_cursor).toBeTruthy();
  const second=decisionListAnswer(all,{cursor:first.next_cursor} as any) as any;expect(second.decisions).toHaveLength(5);
  expect(new Set([...first.decisions,...second.decisions].map(x=>x.id)).size).toBe(25);
  expect((decisionListAnswer(all,{id:all[0]!.id}) as any).decision).not.toHaveProperty("content");
  expect((decisionListAnswer(all,{id:all[0]!.id,detail:true} as any) as any).decision).toEqual(all[0]);
  expect(decisionListAnswer(all,{detail:true} as any)).toEqual(all);
  expect(()=>decisionListAnswer(all.slice(20),{cursor:first.next_cursor} as any)).toThrow(/cursor/i);
 });
 it("board get is compact, detail retains full checklist and comments",()=>{
  const db=rig();const card=db.board.createCards(actor,{cards:[{title:"Small task",goal:"long goal",acceptance:["must pass"],assignee:"dev"} as any]}).cards[0]!;
  const got=JSON.parse(boardToolAction(db,"dev",{action:"get",id:card.code})!);
  expect(got.task).toMatchObject({id:card.uuid,code:card.code,title:card.title,version:card.version});expect(got.task).not.toHaveProperty("goal");
  expect(boardToolAction(db,"dev",{action:"get",id:card.code,detail:true})).toContain("must pass");
 });
 it("board paging reaches beyond its old 50-card cap without changing store defaults",()=>{
  const db=rig();const project=db.board.createProject({kind:"person",name:"host"},{name:"Owned"});
  for(let i=0;i<63;i++)db.board.createCards(actor,{cards:[{title:`Card ${i}`,project:project.id}]});
  expect(db.board.listCards({project:project.id}).cards).toHaveLength(50);
  const ids:string[]=[];let pages=0;let cursor: string|undefined;
  do{expect(++pages).toBeLessThan(10);const page=JSON.parse(boardToolAction(db,"dev",{action:"list",project:project.id,limit:20,...(cursor?{cursor}:{})})!);ids.push(...page.tasks.map((x:any)=>x.id));cursor=page.next_cursor;}while(cursor);
  expect(ids).toHaveLength(63);expect(new Set(ids).size).toBe(63);
  expect(boardToolAction(db,"dev",{action:"list",project:project.id,detail:true})).toContain("13 more");
 });
 it("plain tasks page before the legacy100 cap on both MCP and HTTP",async()=>{
  const db=rig();for(let i=0;i<125;i++)db.createTask({title:`Task ${i}`,description:"body",created_by:"dev"});
  const sent:any[]=[];const fake:any={scheduler:{db},fleetConfig:{instances:{dev:{working_directory:"/owned"}}},logger:{info(){},warn(){}},instanceIpcClients:new Map([["dev",{send:(m:any)=>sent.push(m)}]])};
  const proto=FleetManager.prototype as any;const ids:string[]=[];let pages=0;let cursor:string|undefined;
  do{expect(++pages).toBeLessThan(10);const args={action:"list",limit:40,...(cursor?{cursor}:{})};const page=await proto.handleTaskCrudHttp.call(fake,"dev",args);proto.handleTaskCrud.call(fake,"dev",{type:"fleet_task",fleetRequestId:"test",payload:args,meta:{instance_name:"dev"}});expect(sent.at(-1).result).toEqual(page);ids.push(...page.tasks.map((x:any)=>x.id));cursor=page.next_cursor;}while(cursor);
  expect(ids).toHaveLength(125);expect(new Set(ids).size).toBe(125);
  const full=await proto.handleTaskCrudHttp.call(fake,"dev",{action:"list",detail:true});expect(full.tasks).toHaveLength(100);expect(full.omitted).toBe(25);
 });
 it("schedules drop full messages by default, preserve detail and target filter",()=>{
  const rows=Array.from({length:22},(_,i)=>({id:`s${i}`,label:`job${i}`,message:"sensitive long body",target:"dev",source:"dev",enabled:true,cron:"0 * * * *",at:null,timezone:"UTC"}));
  const list=(target?:string)=>target==="other"?[]:rows;const fake:any={scheduler:{list}};
  const run=(args:any)=>(FleetManager.prototype as any).performScheduleOp.call(fake,"dev","list",args,{chatId:"",threadId:null});
  const page=run({});expect(page.schedules).toHaveLength(20);expect(JSON.stringify(page)).not.toContain("sensitive");expect(run({cursor:page.next_cursor}).schedules).toHaveLength(2);expect(run({detail:true})).toEqual(rows);expect(run({target:"other"}).schedules).toEqual([]);
 });
 it("unknown cursors and mixed legacy/page options are refused, never ignored",()=>{
  const all:any[]=[{id:"owned",title:"Only",scope:"fleet",updated_at:"2026-11-13",content:"body"}];
  expect(()=>decisionListAnswer(all,{cursor:"hidden"})).toThrow(/cursor/);
  expect(()=>decisionListAnswer(all,{detail:true,limit:2})).toThrow(/omit/);
  expect(()=>decisionListAnswer(all,{full:true,cursor:"owned"})).toThrow(/omit/);
  expect(()=>decisionListAnswer(all,{id:"owned",limit:2})).toThrow(/single decision/);
  const db=rig();db.board.createCards(actor,{cards:[{title:"One"}]});
  expect(()=>boardToolAction(db,"dev",{action:"list",project:"none",cursor:"unknown"})).toThrow(/cursor/);
  expect(()=>boardToolAction(db,"dev",{action:"list",verbose:true,limit:2})).toThrow(/omit/);
  expect(()=>boardToolAction(db,"dev",{action:"update",id:"M-1",detail:true,state:"must not save"})).toThrow(/does not take/);
  expect(db.board.getCard("M-1").state).toBe("");
 });
 it("page/detail schemas are strict about values",()=>{
  for(const schema of [ListSchedulesArgs,ListDecisionsArgs,TaskBoardArgs]){
   const base=schema===TaskBoardArgs?{action:"list"}:{};
   expect(schema.safeParse({...base,detail:true}).success).toBe(true);
   expect(schema.safeParse({...base,limit:0}).success).toBe(false);
   expect(schema.safeParse({...base,limit:101}).success).toBe(false);
   expect(schema.safeParse({...base,detail:"true"}).success).toBe(false);
  }
 });
});
