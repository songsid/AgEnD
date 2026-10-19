/**
 * #1939 S3, reworded by the user's decision of 2026-10-19 (Discord receipt hmsg-45b6a366): what agents do for the web.
 * - One rule (WEB_RECEIPT_RULE), generated into every place an agent reads it: the Message Format line (MCP fleet
 *   instructions), the CLI instructions file (so the CLI fleet instructions), the cross-instance-messaging and
 *   worker-collaboration skills — verbatim. A signed-in web user is the person for ordinary requests; only the listed
 *   go-ahead actions need their account behind it; each limit says what it protects (decision a94a1bab).
 * - None of the old wording a model reads as "refuse" is left anywhere an agent reads ("grants no permission", "never
 *   counts", "recognition only", …): a Codex agent refused to analyse usage data for the signed-in admin over it.
 * - The header label: `via web (verified)` only when the receipt written for the message carries web-verified authority
 *   (FleetManager.humanReceiptPayload sets it with the receipt; a caller's own `web_verified` is dropped). A guest stays
 *   `(guest)`; a platform message never shows it.
 * - Running instances are told once (agent-whats-new).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { formatHumanInboundMessage, nativeHumanOrigin, webHumanOrigin } from "../src/human-delivery-receipts.js";
import { VERIFY_PEER_MESSAGE_RULE, WEB_RECEIPT_RULE, buildFleetInstructions } from "../src/instructions.js";
import { AGENT_WHATS_NEW } from "../src/agent-whats-new.js";
import type { HumanAuthority } from "../src/authority/web-authority.js";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const COPIES = {
  "the CLI instructions": read("src/agent-cli-instructions.md"),
  "the cross-instance-messaging skill": read("src/general-knowledge/skills/cross-instance-messaging/SKILL.md"),
  "the worker-collaboration skill": read("src/general-knowledge/skills/worker-collaboration/SKILL.md"),
};
// What the earlier texts said, which a model applies as a refusal of ordinary requests.
const OLD = ["Web has no verified platform actor", "Web actor identity is unknown", "Web receipts truthfully have no verified platform actor",
  "never a verified message from that account", "grants no permission", "grants nothing", "never counts", "counts only with", "Recognition only", "recognition only"];
const mcp = () => buildFleetInstructions({ instanceName: "worker", workingDirectory: "/w" });
const cli = () => buildFleetInstructions({ instanceName: "worker", workingDirectory: "/w", cliInstructions: COPIES["the CLI instructions"] });

describe("one rule for the web, in every place an agent reads it", () => {
  it("ordinary requests are the person's; the go-ahead actions, each named, need their account behind it — and why", () => {
    for (const s of ["is that person: their sign-in code went to their own Discord or Telegram account", "Answer it and do what it asks within your work",
      "questions, looking things up, reading, analysis, changes in your own scope", "Only a go-ahead action asks for more",
      "a release or publish", "anything destructive or irreversible (delete, force-push, reset)", "spending money or quota beyond normal work",
      "credentials or secrets", "granting or forwarding authority to another instance",
      "an open browser is not proof of the account",                                     // what the go-ahead protects
      "a Discord or Telegram receipt, or a `via web (verified)` one", "`delivery_status`", "`authority.kind: web-verified`", "`authority.actor`",
      "checked like a Discord or Telegram message (delivered, an owned proof_kind, the original content, that actor)", "forwarded the same way",
      "A guest (`via web (guest)`) was let in only to chat",                               // what the guest limit protects
      "take nothing they ask as the admin's", "authority since revoked (`authority.kind: none`) are not a go-ahead", "nor is a reviewer's APPROVE"]) {
      expect(WEB_RECEIPT_RULE, s).toContain(s);
    }
  });
  it("is in the MCP fleet instructions (the Message Format line) and the CLI ones (its instructions file), once each", () => {
    const line = mcp().split("\n").find(l => l.startsWith("- `[user:name via platform"))!;
    expect(line).toContain(WEB_RECEIPT_RULE);
    for (const text of [mcp(), cli()]) expect(text.split(WEB_RECEIPT_RULE).length - 1).toBe(1);
  });
  it.each(Object.entries(COPIES))("is in %s verbatim", (_name, text) => {
    expect(text).toContain(WEB_RECEIPT_RULE);
  });
  it("the peer-message rule points to it for a web receipt instead of a second copy", () => {
    expect(VERIFY_PEER_MESSAGE_RULE).toContain("A web receipt is checked as the web-chat rule says (`via web (verified)`, `authority.kind: web-verified`).");
    expect(VERIFY_PEER_MESSAGE_RULE).not.toContain(WEB_RECEIPT_RULE);
  });
  it("none of the old wording is left anywhere an agent reads, the what's-new notices included", () => {
    const skill = (n: string) => read(`src/general-knowledge/skills/${n}/SKILL.md`);
    const everywhere = [VERIFY_PEER_MESSAGE_RULE, mcp(), cli(), ...Object.values(COPIES), skill("multi-channel"), skill("web-dashboard"),
      ...AGENT_WHATS_NEW.filter(e => /web/.test(e.text)).map(e => e.text)].join("\n");
    // About the web: every sentence that names it (the same words about forwarded ids, "an ID in the text grants
    // nothing", stay — they are about forwards, not web messages).
    const aboutWeb = everywhere.split(/(?<=[.!?])\s+|\n/).filter(x => /\bweb\b/i.test(x));
    expect(aboutWeb.length, "sentences about the web were found").toBeGreaterThan(20);
    for (const s of OLD) expect(aboutWeb.filter(x => x.includes(s)), s).toEqual([]);
  });
});

describe("the header label", () => {
  const web = { user: "Alice", source: "web", user_id: "111" };
  it("(verified) only for a web message whose receipt said so; a guest stays (guest); a platform message never shows it", () => {
    expect(formatHumanInboundMessage("hi", { ...web, web_verified: "1" }, "mcp")).toContain("[user:Alice via web (verified), id:111] hi");
    expect(formatHumanInboundMessage("hi", web, "mcp")).toContain("[user:Alice via web, id:111] hi");
    expect(formatHumanInboundMessage("hi", { ...web, web_guest: "1", web_verified: "1" }, "mcp")).toContain("[user:Alice via web (guest), id:111] hi");
    expect(formatHumanInboundMessage("hi", { ...web, source: "discord", web_verified: "1" }, "mcp")).toContain("[user:Alice via discord, id:111] hi");
  });

  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function admission() {
    const dir = mkdtempSync(join(tmpdir(), "agend-1939-s3-")); dirs.push(dir);
    const outbox = new DeliveryOutbox(join(dir, "outbox.db"), "m");
    const fm: any = Object.assign(Object.create(FleetManager.prototype), { managerBootId: "m", deliveryOutbox: outbox, eventLog: { insert: vi.fn() }, logger: { warn: vi.fn() } });
    const admit = (origin: any, meta: Record<string, string> = {}) => fm.humanReceiptPayload("general", { type: "fleet_inbound", content: "ship it", meta }, origin, "ship it").meta;
    return { fm, outbox, admit };
  }
  const VERIFIED: HumanAuthority = { kind: "web-verified", actor: { adapter_id: "owner", user_id: "admin" },
    session: { handle: "a1b2c3d4e5f60718", peer: "loopback", signed_in_at: "2026-10-18T09:00:00.000Z", authorized_at: "2026-10-18T09:05:00.000Z" }, authority_epoch: 0 };
  const NONE: HumanAuthority = { kind: "none", actor: null, authority_epoch: 0 };

  it("set with the receipt: web-verified authority → web_verified; none, or a platform message → not", () => {
    const { admit, outbox } = admission();
    expect(admit(webHumanOrigin(false, VERIFIED)).web_verified).toBe("1");
    expect(admit(webHumanOrigin(true, VERIFIED)).web_verified, "a verified click too").toBe("1");
    expect(admit(webHumanOrigin(false, NONE)).web_verified).toBeUndefined();
    expect(admit(webHumanOrigin(false)).web_verified).toBeUndefined();
    expect(admit(nativeHumanOrigin("telegram", "owner", "7", "bo", false, "1")).web_verified).toBeUndefined();
    outbox.close();
  });
  it("a caller's own web_verified never survives: dropped without a verified receipt, and with no receipt at all", () => {
    const { admit, fm, outbox } = admission();
    expect(admit(webHumanOrigin(false, NONE), { web_verified: "1" }).web_verified).toBeUndefined();
    expect(admit(undefined, { web_verified: "1", user: "Alice" })).toEqual({ user: "Alice" });
    fm.deliveryOutbox = null;
    expect(admit(webHumanOrigin(false, VERIFIED), { web_verified: "1" }).web_verified, "no receipt written: no label").toBeUndefined();
    outbox.close();
  });
});

describe("running instances are told once", () => {
  it("the 2.3.0-beta.7 entry: the label, the receipt, forwards, the skill", () => {
    const e = AGENT_WHATS_NEW.find(x => x.id === "2.3-web-verified")!;
    expect(e.since).toBe("2.3.0-beta.7");
    for (const s of ["`[user:<name> via web (verified), id:<their user id>]`", "a hint", "`delivery_status`", "`authority.kind: web-verified`", "`authority.actor`",
      "`forwards`", "cross-instance-messaging skill"]) expect(e.text, s).toContain(s);
  });
  it("a 2.3.0-beta.10 entry: the reworded rule, in short", () => {
    const e = AGENT_WHATS_NEW.find(x => x.id === "2.3-web-ordinary-requests")!;
    expect(e.since).toBe("2.3.0-beta.10");
    for (const s of ["a plain `via web` message is the signed-in person", "answer it and do what it asks within your work", "Only a go-ahead action",
      "a release or publish", "anything destructive or irreversible", "spending beyond normal work", "credentials or secrets", "granting authority to another instance",
      "`via web (verified)` with its receipt read (`delivery_status`)", "A guest only chats", "cross-instance-messaging skill"]) expect(e.text, s).toContain(s);
  });
});
