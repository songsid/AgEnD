import {z} from "zod";
export const HUB_AGENT_INTRO_CAPABILITY="agent-intro-v1";
export const agentIntroSchema=z.strictObject({exposureId:z.uuid(),revision:z.number().int().min(1),text:z.string(),source:z.enum(["default","agent"])});
export const agentIntroResultSchema=z.union([
 z.strictObject({ok:z.literal(true),intro:z.string(),introBy:z.enum(["default","agent","owner"]),introAt:z.number().int().min(0),changed:z.boolean()}),
 z.strictObject({ok:z.literal(false),code:z.enum(["invalid","limit","denied","unavailable","unsupported","stale"]),resetsAt:z.number().int().min(0).optional()})
]);
export type HubAgentIntro=z.infer<typeof agentIntroSchema>;
export type HubAgentIntroResult=z.infer<typeof agentIntroResultSchema>;
/** A default is only a starting line; the sharing UI must show it before access is granted. */
export function defaultAgentIntro(description:string):string {
 const line=description.split(/\r\n|[\r\n\u2028\u2029]/u)[0]??"";
 const text=line.normalize("NFC").replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu," ").replace(/\s+/gu," ").trim();
 return [...new Intl.Segmenter(undefined,{granularity:"grapheme"}).segment(text)].slice(0,50).map(s=>s.segment).join("");
}
