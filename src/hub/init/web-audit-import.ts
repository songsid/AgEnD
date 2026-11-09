/** Mounted Hub-only import. Bootstrap evidence and its dedup marker commit in the same audit transaction. */
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { HubMigration } from "../db.js";
import type { HubAuditStore } from "../audit/index.js";
import { WEB_INIT_AUDIT, readHubWebInitEvents } from "./web-audit.js";
export const HUB_WEB_INIT_AUDIT_MIGRATION: HubMigration = {
  component: "s5-web-initialization-audit", version: 1,
  up(db) { db.exec("CREATE TABLE IF NOT EXISTS hub_web_initialization_audit(id TEXT PRIMARY KEY, image TEXT NOT NULL)"); },
};
export function importHubWebInitAudit(input: {
  home: string;
  db: Database.Database;
  audit: HubAuditStore;
  hubId: string;
  version: number;
}): void {
  try {
    lstatSync(join(input.home, WEB_INIT_AUDIT));
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return;
    throw error;
  }
  const events = readHubWebInitEvents(input.home);
  const read = input.db.prepare("SELECT image FROM hub_web_initialization_audit WHERE id=?");
  const insert = input.db.prepare("INSERT INTO hub_web_initialization_audit(id,image) VALUES(?,?)");
  input.db.transaction(() => {
    for (const event of events) {
      if (event.hubId !== undefined && event.hubId !== input.hubId)
        throw Error("setup-audit-mismatch");
      const image = createHash("sha256").update(JSON.stringify(event)).digest("hex");
      const prior = read.get(event.id) as {
        image: string;
      } | undefined;
      if (prior) {
        if (prior.image !== image)
          throw Error("setup-audit-mismatch");
        continue;
      }
      input.audit.appendInTransaction({ id: event.id, sequence: 0, at: event.at, requestId: event.requestId,
        actor: { kind: "local-host" }, action: `hub-initialization.${event.operation}`, result: event.result,
        policyVersion: input.version, reasonCode: event.reason }, input.db);
      insert.run(event.id, image);
    }
  }).immediate();
}
