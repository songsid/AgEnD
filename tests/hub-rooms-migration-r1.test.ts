import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { applyHubMigrations } from "../src/hub/db.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";

it("migrates once, preserves direct-room bytes and refuses an older migration registry", () => {
  const db = new Database(":memory:"), older = HUB_HTTP_MIGRATIONS.filter(m => !["s3-rooms", "s3-room-agents", "s3-room-creators", "s3-room-assistant"].includes(m.component));
  try {
    applyHubMigrations(db, older);
    const id = randomUUID(), grant = randomUUID(), owner = `corp/${randomUUID()}`, asker = `corp/${randomUUID()}`, exposure = randomUUID();
    db.prepare("INSERT INTO hub_exposures(id,fleet_id,owner,display_name,revision,state,data_view_id,allowed_tools,policy_digest,updated_at) VALUES(?,?,?,'Agent',1,'published','v','[]',?,0)").run(exposure, randomUUID(), owner, "a".repeat(64));
    db.prepare("INSERT INTO hub_grants(id,revision,owner,exposure_id,exposure_revision,approved_by,approved_at,subject,permissions,starts_at,expires_at,state) VALUES(?,3,?,?,1,?,0,?,'[\"ask\"]',0,999,'active')").run(grant, owner, exposure, owner, asker);
    db.prepare("INSERT INTO hub_rooms VALUES(?,?,?,?,?,'active',123)").run(id, asker, exposure, owner, grant);
    const before = db.prepare("SELECT * FROM hub_rooms").all();
    applyHubMigrations(db, HUB_HTTP_MIGRATIONS); applyHubMigrations(db, HUB_HTTP_MIGRATIONS);
    expect(db.prepare("SELECT * FROM hub_rooms").all()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM hub_group_rooms").get()).toEqual({ n: 0 });
    expect(() => applyHubMigrations(db, older)).toThrow(/s3-rooms/);
  } finally { db.close(); }
});

it("adds retained agent deliveries without changing existing group message or membership fields", () => {
  const db = new Database(":memory:"), r1 = HUB_HTTP_MIGRATIONS.filter(m => !["s3-room-agents", "s3-room-creators", "s3-room-assistant"].includes(m.component));
  try {
    applyHubMigrations(db, r1);
    const room = randomUUID(), member = randomUUID(), post = randomUUID(), person = `corp/${randomUUID()}`;
    db.prepare("INSERT INTO hub_group_rooms(id,name,created_by,created_at) VALUES(?,'Existing',?,123)").run(room, person);
    db.prepare("INSERT INTO hub_room_members(id,room_id,kind,subject,role,joined_sequence,read_sequence) VALUES(?,?,'person',?,'manager',0,1)").run(member, room, person);
    db.prepare("INSERT INTO hub_room_posts(id,room_id,sequence,author_kind,author_id,author_subject,author_name,content_ref,digest,mentions,idempotency_key,created_at) VALUES(?,?,1,'person',?,?,'Alex','opaque-ref',?,'[]',?,123)")
      .run(post, room, member, person, "b".repeat(64), randomUUID());
    const beforeMember = db.prepare("SELECT * FROM hub_room_members").get(), beforePost = db.prepare("SELECT * FROM hub_room_posts").get();
    applyHubMigrations(db, HUB_HTTP_MIGRATIONS); applyHubMigrations(db, HUB_HTTP_MIGRATIONS);
    expect(db.prepare("SELECT * FROM hub_room_members").get()).toMatchObject(beforeMember as object);
    expect(db.prepare("SELECT * FROM hub_room_posts").get()).toMatchObject(beforePost as object);
    expect(db.prepare("SELECT owner_at_join FROM hub_room_members").get()).toEqual({ owner_at_join: null });
    expect(db.prepare("SELECT COUNT(*) n FROM hub_room_deliveries").get()).toEqual({ n: 0 });
    expect(() => applyHubMigrations(db, r1)).toThrow();
  } finally { db.close(); }
});

it("adds creator and assistant storage once without changing retained R2 membership or posts", () => {
  const db = new Database(":memory:"), r2 = HUB_HTTP_MIGRATIONS.filter(m => !["s3-room-creators", "s3-room-assistant"].includes(m.component));
  try {
    applyHubMigrations(db, r2);
    const room = randomUUID(), member = randomUUID(), person = `corp/${randomUUID()}`;
    db.prepare("INSERT INTO hub_group_rooms(id,name,created_by,created_at) VALUES(?,'Retained',?,123)").run(room, person);
    db.prepare("INSERT INTO hub_room_members(id,room_id,kind,subject,role,joined_sequence,read_sequence) VALUES(?,?,'person',?,'manager',0,7)").run(member, room, person);
    const before = db.prepare("SELECT * FROM hub_room_members").all(), roomBefore = db.prepare("SELECT * FROM hub_group_rooms").get() as object;
    applyHubMigrations(db, HUB_HTTP_MIGRATIONS); applyHubMigrations(db, HUB_HTTP_MIGRATIONS);
    expect(db.prepare("SELECT * FROM hub_room_members").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM hub_group_rooms").get()).toMatchObject({ ...roomBefore, assistant_for: null });
    expect(db.prepare("SELECT COUNT(*) n FROM hub_room_creators").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM hub_room_assistant_calls").get()).toEqual({ n: 0 });
    expect(() => applyHubMigrations(db, r2)).toThrow(/s3-room-/);
  } finally { db.close(); }
});
