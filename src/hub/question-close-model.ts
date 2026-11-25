import { z } from "zod";
import { uuid } from "./validation.js";

/** Owner stop, not an answer or a new grant. Older Hubs must never receive this operation. */
export const HUB_QUESTION_CLOSE_CAPABILITY = "question-close-v1";
export const questionCloseSchema = z.strictObject({ messageId: uuid, exposureId: uuid });
export const questionCloseResultSchema = z.strictObject({ messageId: uuid, outcome: z.enum(["closed", "answered"]) });
export type HubQuestionClose = z.infer<typeof questionCloseSchema>;
export type HubQuestionCloseResult = z.infer<typeof questionCloseResultSchema>;

export type HubHeldCloseOutcome = HubQuestionCloseResult["outcome"] | "not-found" | "unavailable" | "unsupported";
