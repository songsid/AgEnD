/** Ordinary no-reply Fleet delivery; each producer owns its exact source mapping and write-ahead input fence. */
export interface HubRoomNotification {
  agent:string;id:string;text:string;kind?:"post-answer"|"mention-feedback";
  beforeInput():Promise<boolean>;
  stillCurrent():boolean;
}
