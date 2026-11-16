import {describe,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {HUB_CAPABILITIES,HUB_OPTIONAL_CAPABILITIES,HUB_ROOM_ASK_CAPABILITY,HUB_ROOM_POST_CAPABILITY,HUB_FLEET_UPDATE_CAPABILITY,
  roomAnswerAckSchema,roomPostResultSchema,roomAnswerSchema,roomPostSchema} from "../src/hub/protocol.js";
import {HUB_ROOM_CONTEXT_CAPABILITY} from "../src/hub/room-context-model.js";
import {HUB_ROOM_MENTION_FEEDBACK_CAPABILITY as FEEDBACK} from "../src/hub/room-mention-feedback-model.js";
import {hubLinkCapabilities} from "../src/hub/compose/server.js";
import {hubWelcomeCapabilities} from "../src/hub/server.js";
describe("mention feedback strict-peer compatibility",()=>{
 it("keeps the legacy 16-name hello and welcome, offering feedback only to known 32-name receivers",()=>{
  const legacy=[...HUB_CAPABILITIES,...HUB_OPTIONAL_CAPABILITIES,HUB_ROOM_ASK_CAPABILITY,HUB_ROOM_POST_CAPABILITY];expect(legacy).toHaveLength(16);
  expect(legacy).not.toContain(FEEDBACK);
  const configured=hubLinkCapabilities({memberConnected:()=>{},memberReady:()=>{},features:["personal-agents-v1",HUB_FLEET_UPDATE_CAPABILITY,HUB_ROOM_ASK_CAPABILITY,HUB_ROOM_POST_CAPABILITY,HUB_ROOM_CONTEXT_CAPABILITY]});
  const oldWelcome=hubWelcomeCapabilities(configured,legacy);expect(oldWelcome).not.toContain(FEEDBACK);expect(z.array(z.string()).max(16).safeParse(oldWelcome).success).toBe(true);
  const modernWelcome=hubWelcomeCapabilities(configured,[...legacy,HUB_FLEET_UPDATE_CAPABILITY]);expect(modernWelcome).toContain(FEEDBACK);expect(modernWelcome.length).toBeLessThanOrEqual(32);
 });
 it("keeps the original ACK/result valid in strict old codecs",()=>{
  const messageId=randomUUID(),answerId=randomUUID(),roomId=randomUUID();
  const ack={messageId,answerId},post={ok:true as const,roomId,messageId,at:1};
  expect(roomAnswerAckSchema.parse(ack)).toEqual(ack);expect(roomPostResultSchema.parse(post)).toEqual(post);
  const oldAck=z.strictObject({messageId:z.string(),answerId:z.string()}),oldPost=z.strictObject({ok:z.literal(true),roomId:z.string(),messageId:z.string(),at:z.number()});
  expect(oldAck.safeParse(ack).success).toBe(true);expect(oldPost.safeParse(post).success).toBe(true);
  const mentionRefusals={id:randomUUID(),refusals:[{code:"personal-people-only",name:"Notes"}]};
  expect(roomAnswerAckSchema.safeParse({...ack,mentionRefusals}).success).toBe(true);expect(oldAck.safeParse({...ack,mentionRefusals}).success).toBe(false);
  expect(roomPostResultSchema.safeParse({...post,mentionRefusals}).success).toBe(true);expect(oldPost.safeParse({...post,mentionRefusals}).success).toBe(false);
 });
 it("requires an explicit true opt-in with bounded closed feedback values",()=>{
  const answer={messageId:randomUUID(),answerId:randomUUID(),roomId:randomUUID(),exposureId:randomUUID(),text:"Answer"};
  expect(roomAnswerSchema.safeParse({...answer,mentionFeedback:true}).success).toBe(true);expect(roomAnswerSchema.safeParse({...answer,mentionFeedback:false}).success).toBe(false);
  expect(roomPostSchema.safeParse({exposureId:randomUUID(),room:randomUUID(),text:"Post",idempotencyKey:randomUUID(),mentionFeedback:true}).success).toBe(true);
  expect(roomAnswerAckSchema.safeParse({messageId:answer.messageId,answerId:answer.answerId,mentionRefusals:{id:randomUUID(),refusals:[{code:"future-unchecked",name:"Notes"}]}}).success).toBe(false);
 });
});
