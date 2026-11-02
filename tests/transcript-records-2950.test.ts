/** Native sources feed the ordinary record grammar without loading a local provider store. */
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';import { tmpdir } from 'node:os';import { join } from 'node:path';
import pino from 'pino';
import { TranscriptMonitor } from '../src/transcript-monitor.js';
import { claudeTranscriptRecord, codexToolRecord, codexTurnRecord, type CodexRecordState, type TranscriptRecordEvent } from '../src/transcript-records.js';
import type { TranscriptEvents, TranscriptSource } from '../src/transcript-sources.js';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});
it('keeps Claude informational, prompt, error, tool and text events ordered through a supplied source',async()=>{
 const records:TranscriptRecordEvent[]=[],emit=(...event:TranscriptRecordEvent)=>{records.push(event);};
 claudeTranscriptRecord({type:'system',subtype:'informational',content:'continue later'},emit);
 claudeTranscriptRecord({type:'user',message:{role:'user',content:'question'}},emit);
 claudeTranscriptRecord({type:'assistant',isApiErrorMessage:true,apiErrorStatus:429,timestamp:'2026-11-02T00:00:00Z',error:'rate_limit',message:{role:'assistant',content:[{type:'text',text:'rate limited'}]}},emit);
 claudeTranscriptRecord({type:'assistant',message:{role:'assistant',content:[{type:'tool_use',name:'Read',input:{file_path:'owned'}},{type:'text',text:'answer'}]}},emit);
 const root=mkdtempSync(join(tmpdir(),'agend-transcript-records-'));roots.push(root);
 const source:TranscriptSource={poll:async()=>({toolUses:[],toolResults:[],assistantTexts:[],records}),reset(){}};
 const monitor=new TranscriptMonitor(root,pino({level:'silent'})as never,source),seen:unknown[]=[];
 for(const type of ['system_informational','user_prompt','api_error','tool_use','assistant_text'])monitor.on(type,(...args)=>seen.push([type,...args]));
 await monitor.pollIncrement();expect(seen).toEqual(records);expect(seen.map((e:any)=>e[0])).toEqual(['system_informational','user_prompt','api_error','tool_use','assistant_text']);monitor.stop();
});
it('Codex boundary state keeps a steer in its open turn and leaves returned output out of assistant text',()=>{
 const state:CodexRecordState={openTurnId:'',openTurn:null,turnKnown:false},turns:any[]=[],events:TranscriptEvents={toolUses:[],toolResults:[],assistantTexts:[]};
 codexTurnRecord({type:'event_msg',payload:{type:'task_started',turn_id:'owned-turn'}},state,turns);
 codexTurnRecord({type:'response_item',timestamp:'2026-11-02T00:00:00Z',payload:{type:'message',role:'user',content:[{type:'input_text',text:'steer'}]}},state,turns);
 codexToolRecord({type:'response_item',payload:{type:'function_call',name:'execute',arguments:'{"command":"read only"}'}},events);
 codexToolRecord({type:'response_item',payload:{type:'function_call_output',output:'<forged assistant text>'}},events);
 codexTurnRecord({type:'event_msg',payload:{type:'task_complete',turn_id:'owned-turn',last_agent_message:'done'}},state,turns);
 expect(state).toEqual({openTurnId:'owned-turn',openTurn:null,turnKnown:true});expect(turns).toMatchObject([{kind:'start',turnId:'owned-turn'},{kind:'user',turnId:'owned-turn',text:'steer'},{kind:'end',turnId:'owned-turn',end:'complete'}]);expect(events.toolUses).toEqual([{name:'execute',input:{command:'read only'}}]);expect(events.assistantTexts).toEqual([]);expect(events.toolResults).toEqual([{name:'unknown'}]);
});
it('a stop during an ordered native batch suppresses every later event',async()=>{
 const root=mkdtempSync(join(tmpdir(),'agend-transcript-records-'));roots.push(root);const records:TranscriptRecordEvent[]=[['user_prompt'],['assistant_text','late']];
 const monitor=new TranscriptMonitor(root,pino({level:'silent'})as never,{poll:async()=>({toolUses:[],toolResults:[],assistantTexts:[],records}),reset(){}});const late=vi.fn();monitor.on('user_prompt',()=>monitor.stop());monitor.on('assistant_text',late);await monitor.pollIncrement();expect(late).not.toHaveBeenCalled();
});
