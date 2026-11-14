import { expect, it } from "vitest";
import { resolveRoomMentions } from "../src/hub/rooms/mentions.js";
const members=[{id:"alex",kind:"person",subject:"person-alex",name:"Alex Chen",login:"alex"},{id:"a",kind:"agent",subject:"agent-a",name:"Notes"},{id:"b",kind:"agent",subject:"agent-b",name:"研發 Planner"}];
it("matches longest complete names, login aliases and CJK, once per target",()=>{
  expect(resolveRoomMentions("@Alex Chen @alex @研發 Planner check @Notes @Unknown",members,"agent-a")).toEqual({people:["alex"],agents:["agent-b"],ambiguous:[],all:false});
  expect(resolveRoomMentions("@alexander @NotesMore",members,"agent-b").people).toEqual([]);
});
it("does not interpret email, escaped @ or inline/fenced code as an outbound mention",()=>{
  expect(resolveRoomMentions("a@alex \\@alex `@alex`\n```\n@All agents @研發 Planner\n```\n~~~\n@Notes\n~~~",members,"agent-a")).toEqual({people:[],agents:[],ambiguous:[],all:false});
});
it("keeps duplicate labels ambiguous and recognises the reserved all aliases",()=>{
  const repeated=[...members,{id:"other",kind:"person",subject:"person-other",name:"Notes"}];
  expect(resolveRoomMentions("@Notes @Notes @所有 Agent",repeated,"agent-b")).toEqual({people:[],agents:[],ambiguous:["Notes"],all:true});
});
