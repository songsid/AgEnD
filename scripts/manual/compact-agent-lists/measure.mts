// An operator-owned capture of actual tool results. Never print titles, messages or bodies.
import {readFileSync} from "node:fs";
import {scheduleListAnswer,pageRows} from "../../../src/agent-list-output.js";
const raw=JSON.parse(readFileSync(process.argv[2]!,"utf8"));
const bytes=(v:unknown)=>Buffer.byteLength(typeof v==="string"?v:JSON.stringify(v));
const decisionPage=pageRows(raw.decisions.decisions,{});
const decisions={decisions:decisionPage.rows,...(decisionPage.next_cursor?{next_cursor:decisionPage.next_cursor}:{}),hint:"Titles only. Follow next_cursor with the same filters for all pages. Use { id, detail: true } for the full rule; detail: true lists all full records (legacy full: true also works)."};
const match=/^(M-\d+) main task · (.+?) \[in progress\] @(\S+) size \w v(\d+)/.exec(raw.taskText);
const tasks=Array.isArray(raw.tasks)?raw.tasks:raw.tasks.tasks;
const row=tasks.find((r:any)=>r.code===match?.[1]);
if(!row || !match) throw new Error("Actual task metadata/text must identify the same card");
const task={task:{id:row.id,code:row.code,title:row.title,status:row.status,assignee:row.assignee,priority:row.priority,version:Number(match[4])},hint:"Use detail:true for goal, acceptance, state and comments before working."};
for(const [name,before,after] of [["list_schedules",raw.schedules,scheduleListAnswer(raw.schedules,{})],["list_decisions",raw.decisions,decisions],["task get",raw.taskText,task]] as const) console.log(JSON.stringify({name,beforeBytes:bytes(before),afterBytes:bytes(after),reductionPct:+((1-bytes(after)/bytes(before))*100).toFixed(1)}));
