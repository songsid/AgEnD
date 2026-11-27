import { expect, it } from "vitest";
import { rotateHubAgentIncarnation, forgetHubAgentIncarnation, requestWorkRegistrationEvidence, hubAgentIncarnationToken, readHubAgentIncarnationRecord } from "../src/hub-agent-incarnation-record.js";
const fp="1".repeat(64), other="2".repeat(64), name="fixture";
it("a durable pending birth is distinct from a missing or consumed work row",()=>{
 const row=rotateHubAgentIncarnation(undefined,fp,false,1,true),inc=hubAgentIncarnationToken(name,row.id!);
 expect(requestWorkRegistrationEvidence(name,row,inc,null)).toBe("birth");
 expect(()=>requestWorkRegistrationEvidence(name,undefined,inc,null)).toThrow();
 expect(()=>requestWorkRegistrationEvidence(name,{...row,requestWork:"registered"},inc,null)).toThrow(/consumed/);
 expect(requestWorkRegistrationEvidence(name,{...row,requestWork:"registered"},inc,inc)).toBe("resume");
 expect(()=>requestWorkRegistrationEvidence("foreign",row,inc,null)).toThrow(/unavailable/);
});
it("rotation and removal retain the exact name's predecessor, including removal and re-add",()=>{
 const first=rotateHubAgentIncarnation(undefined,fp,false,1,true),before=hubAgentIncarnationToken(name,first.id!);
 const removed=forgetHubAgentIncarnation(first,2);expect(removed.id).toBeUndefined();
 const next=rotateHubAgentIncarnation(removed,fp,false,3),inc=hubAgentIncarnationToken(name,next.id!);
 expect(next.id).not.toBe(first.id);expect(requestWorkRegistrationEvidence(name,next,inc,before)).toBe("successor");
 expect(()=>requestWorkRegistrationEvidence(name,next,inc,null)).toThrow(/predecessor/);
 expect(()=>requestWorkRegistrationEvidence(name,next,inc,hubAgentIncarnationToken("foreign",first.id!))).toThrow(/predecessor/);
});
it("bounded history eviction refuses an older work row; it never recreates first birth",()=>{
 let row=rotateHubAgentIncarnation(undefined,fp,false,0,true);const old=hubAgentIncarnationToken(name,row.id!);
 for(let n=1;n<=9;n++)row=rotateHubAgentIncarnation(row,n%2?fp:other,false,n);
 expect(row.retired).toHaveLength(8);const inc=hubAgentIncarnationToken(name,row.id!);
 expect(()=>requestWorkRegistrationEvidence(name,row,inc,old)).toThrow(/predecessor/);
 expect(()=>requestWorkRegistrationEvidence(name,row,inc,null)).toThrow(/predecessor/);
});
it("malformed or duplicated history cannot be used as lifecycle evidence",()=>{
 const row=rotateHubAgentIncarnation(undefined,fp,true,1,true);
 expect(()=>readHubAgentIncarnationRecord({...row,retired:[{id:row.id,fp,at:1}]})).toThrow();
 expect(()=>rotateHubAgentIncarnation({id:row.id,fp:"broken"},fp,false)).toThrow();
 const legacy={id:row.id,fp};expect(readHubAgentIncarnationRecord(legacy)).toEqual(legacy);
 expect(()=>requestWorkRegistrationEvidence(name,legacy,hubAgentIncarnationToken(name,row.id!),null)).toThrow(/unavailable/);
});

it("a lazy current-token creation cannot invent first birth after missing registration files",()=>{
 const row=rotateHubAgentIncarnation(undefined,fp,false,1),inc=hubAgentIncarnationToken(name,row.id!);
 expect(row.requestWork).toBeUndefined();expect(()=>requestWorkRegistrationEvidence(name,row,inc,null)).toThrow(/unavailable/);
});
