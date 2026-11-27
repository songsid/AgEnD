/** Bound completion receipts beside the strict legacy ask journal; old readers ignore this table. */
import type Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { HubProtocolError } from "../validation.js";

const receipt = z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/), emoji: z.string().min(1).max(16), at: z.number().int().nonnegative() });
export class RoomReactionAcks {
  constructor(private readonly db: Database.Database, private readonly binding: string, private readonly key: Buffer) {
    // Additive companion, not a new component/version that would reject an older journal opener.
    db.exec("CREATE TABLE IF NOT EXISTS hub_room_reaction_acks(message_id TEXT PRIMARY KEY REFERENCES hub_room_asks(message_id) ON DELETE CASCADE,value TEXT NOT NULL)");
  }
  ids(): string[] { return (this.db.prepare("SELECT message_id FROM hub_room_reaction_acks").all() as {message_id:string}[]).map(r => r.message_id); }
  private aad(id: string): Buffer { return Buffer.from(JSON.stringify(["room-react-ack-v1",this.binding,id])); }
  has(id: string, digest: string): boolean {
    const row = this.db.prepare("SELECT value FROM hub_room_reaction_acks WHERE message_id=?").get(id) as {value:string}|undefined;
    if (!row) return false;
    try {
      const bytes=Buffer.from(row.value,"base64"), cipher=createDecipheriv("aes-256-gcm",this.key,bytes.subarray(0,12));
      cipher.setAAD(this.aad(id));cipher.setAuthTag(bytes.subarray(12,28));
      const value=receipt.parse(JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString("utf8")));
      if(value.digest!==digest)throw Error();
      return true;
    }catch{throw new HubProtocolError("uncertain");}
  }
  record(id: string, digest: string, emoji: string, at: number): void {
    if(this.has(id,digest))return;
    const value=receipt.parse({digest,emoji,at}),iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",this.key,iv);
    cipher.setAAD(this.aad(id));
    const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
    this.db.prepare("INSERT INTO hub_room_reaction_acks VALUES(?,?)").run(id,Buffer.concat([iv,cipher.getAuthTag(),data]).toString("base64"));
  }
}
