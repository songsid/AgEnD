/** Hub-only offer. A request opts in separately, so strict old peers keep their original ACK/result shapes. */
import {z} from "zod";
import {plain,uuid} from "./validation.js";
export const HUB_ROOM_MENTION_FEEDBACK_CAPABILITY="room-mention-feedback-v1";
export const roomMentionFeedbackSchema=z.strictObject({id:uuid,refusals:z.array(z.strictObject({
  code:z.literal("personal-people-only"),name:plain(256).refine(s=>s.trim().length>0),
})).min(1).max(64)});
export type HubRoomMentionFeedback=z.infer<typeof roomMentionFeedbackSchema>;
export function formatRoomMentionFeedback(value:HubRoomMentionFeedback,locale:"en"|"zh-TW"="en"):string {
  return value.refusals.map(r=>locale==="zh-TW"?`沒有送出：${r.name} 是個人 Agent，只回答人的提問。`:
    `Not delivered: ${r.name} is a personal agent and answers people only.`).join("\n");
}
