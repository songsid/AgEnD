/**
 * The `hub` knowledge skill — the AgEnD Hub from the user's side (administrator and colleague). Like the web-dashboard
 * skill it is published on demand to General, workers and ClassicBot rooms, and it must not drift from the code: its
 * numbers are the code's, every label it quotes is a string the UI has, its index points at real sections, and it
 * carries no company specifics (addresses, directory names, accounts).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { GENERAL_SKILL_NAMES } from "../src/general-role.js";
import { AGENT_WHATS_NEW } from "../src/agent-whats-new.js";
import { enrolmentCreate } from "../src/hub/enrolment-code.js";
import { HUB_EXPOSURE_MAX } from "../src/hub/member/exposures.js";

const PATH = join(process.cwd(), "src/general-knowledge/skills/hub/SKILL.md");
const SKILL = readFileSync(PATH, "utf8");
/** The skill with its hard line wraps removed: a label or sentence that wraps is still one label. */
const FLAT = SKILL.replace(/\s*\n\s*/g, " ");
const UI = join(process.cwd(), "src/ui");
const SOURCES = readdirSync(UI).filter(f => f.endsWith(".js")).map(f => readFileSync(join(UI, f), "utf8")).join("\n");
const source = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

describe("the hub skill", () => {
  it("has the skill frontmatter, for General, workers and ClassicBot agents", () => {
    const m = SKILL.match(/^---\n([\s\S]*?)\n---\n/);
    expect(m, "frontmatter").toBeTruthy();
    const fm = parseDocument(m![1]!).toJS() as { name: string; description: string; roles: string[] };
    expect(fm.name).toBe("hub");
    expect(fm.description.length).toBeGreaterThan(40);
    expect(fm.description.length).toBeLessThan(420);
    expect(fm.roles).toEqual(["general", "worker", "classic"]);
    expect(GENERAL_SKILL_NAMES).toContain("hub");
  });

  it("is published to a worker's native skill directory, as one SKILL.md", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-skill-hub-data-")), work = mkdtempSync(join(tmpdir(), "agend-skill-hub-work-"));
    try {
      const fm = new FleetManager(dataDir);
      (fm as any).fleetConfig = {};
      (fm as any).syncRoleSkills(work, "claude-code", "worker", join(process.cwd(), "src/general-knowledge"));
      const published = join(work, ".claude/skills/hub/SKILL.md");
      expect(existsSync(published), "published to the worker").toBe(true);
      expect(readFileSync(published, "utf8")).toBe(SKILL);
      expect((fm as any).readManagedSkillRoles(PATH)).toEqual(["general", "worker", "classic"]);
    } finally { rmSync(dataDir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
  });

  it("covers both sides, with an index pointing at real sections", () => {
    for (const h of ["What the Hub is", "Setting up a Hub", "Signing in to the Hub", "Letting colleagues join", "Join codes", "Connecting a Fleet",
      "Held, refused and queued connections", "Sharing agents", "Who may ask", "Asking an agent", "Group permissions", "Administration",
      "Config keys", "Limits", "Not available yet", "Troubleshooting"]) expect(SKILL, h).toContain(`\n## ${h}\n`);
    const anchors = [...SKILL.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map(m => m[1]!);
    const slugs = [...SKILL.matchAll(/\n## (.+)\n/g)].map(m => m[1]!.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-"));
    expect(anchors.length).toBeGreaterThan(16);
    expect(anchors.filter(a => !slugs.includes(a))).toEqual([]);
  });

  it("its numbers are the code's", () => {
    const d = enrolmentCreate.parse({ scope: { kind: "directory" } });
    expect([d.expires, d.maxUses, d.perPersonFleets]).toEqual(["today", 30, 1]);
    const ok = (v: unknown) => enrolmentCreate.safeParse({ scope: { kind: "directory" }, ...(v as object) }).success;
    expect([ok({ maxUses: 200 }), ok({ maxUses: 201 }), ok({ perPersonFleets: 8 }), ok({ perPersonFleets: 9 })]).toEqual([true, false, true, false]);
    expect([ok({ expires: "1h" }), ok({ expires: "7d" }), ok({ expires: "30d" })]).toEqual([true, true, false]);
    expect(FLAT).toContain("**Maximum Fleets:** 1–200, 30 by default.");
    expect(FLAT).toContain("**Fleets per person:** 1–8, 1 by default.");
    expect(FLAT).toContain("In 1 hour, End of today (the default), or In 7 days");
    // 8 live codes and 10 per hour: the limits the code enforces and the sentences the page shows for them.
    const codes = source("src/hub/enrolment-code.ts");
    expect(codes).toMatch(/=== "live"\)\.length >= 8/);
    expect(codes).toMatch(/now - 3600000\)\.length >= 10/);
    expect(FLAT).toContain("At most 8 join codes can be live. End one before creating another.");
    expect(FLAT).toContain("At most 10 join codes can be created in one hour. Try again later.");
    expect(codes).toMatch(/- 7 \* 86400000/);   // ended codes stay listed for 7 days
    expect(FLAT).toContain("ended codes stay listed for 7 days");
    expect(HUB_EXPOSURE_MAX).toBe(64);
    expect(FLAT).toContain(`| Agents one Fleet can share | ${HUB_EXPOSURE_MAX} `);
    const join_ = source("src/hub/join/service.ts");
    expect(join_).toMatch(/outerDeadline = now \+ 600_000/);     // one attempt: 10 minutes
    expect(join_).toMatch(/expiresAt: now \+ 600_000/);          // an individual invitation: 10 minutes
    expect(join_).toMatch(/256 - this\.options\.store\.read\(\)\.fleets\.length/);
    expect(FLAT).toContain("| Fleets connected to one Hub | 256 |");
    expect(FLAT).toContain("| One connection attempt | 10 minutes |");
    expect(FLAT).toContain("| An individual invitation | valid 10 minutes |");
    expect(source("src/ui/hub-join-queue.js")).toMatch(/mine\.attempts >= 9/);   // the first try plus 8 retries
    expect(FLAT).toContain("| Queue retries when the Hub is busy | 8 |");
    expect(source("src/ui/panel-hub.js")).toContain("const DAYS = [1, 7, 30, 90];");
    expect(FLAT).toContain("**For** 1, 7, 30 or 90 days");
  });

  it("every label it quotes is a string the UI has", () => {
    const labels = ["Sign in to the Hub", "Account", "Password", "Sign in", "Sign in and connect Fleet", "That account and password didn't work.",
      "Let colleagues join", "Allow company-account Fleet connections", "Who can join", "Each person up to", "Chat with agents", "Share agents",
      "Add by distinguished name", "Tell colleagues how to join", "Copy these instructions", "Finish steps 1 and 2 first.", "Individual invitations",
      "Link with key fingerprint (Advanced)", "Edit AD connection", "Create join code", "Valid until", "Maximum Fleets", "Who can use it",
      "Anyone in the company directory", "One company group", "Use the group's distinguished name", "Find group", "Fleets per person",
      "Recent connections", "End this code now", "End this join code?", "This code cannot be used again.", "Fleets already connected are unchanged.",
      "Expired", "Used up", "Hub address", "Join code included.", "Looking up the Hub…", "Rename", "Sign in with company account", "Go to the confirm card",
      "Connected. You can close this tab.", "Reconnect", "Remove this connection", "Other ways", "Allow this fleet to connect to a Hub", "Hub membership",
      "Connection needs attention", "Recover this connection", "Cancel connection", "Check again", "Open Hub", "Replace saved Hub identity",
      "Shared agents", "Waiting for your confirmation", "Shared: Hub questions go to this agent's own conversation.", "Don't share it", "Share again",
      "This fleet has no agents to share yet.", "Stop sharing…", "Sharing stopped on the Hub", "Allow someone to ask…", "My shared agents", "Who may ask",
      "Allow…", "Their sign-in name", "Hasn't signed in to Hub yet", "Revoke…", "Recent questions", "Subscription quota", "Show quota to people asking",
      "Chats", "New chat", "Waiting for the owner's fleet", "At the owner's fleet", "Answered", "Not answered", "Outcome unknown",
      "Open on the Hub", "Connect a fleet", "People excluded", "What this change does", "Turn on and save", "Turn off", "Resume", "Paused",
      "Chat with an agent", "Connect your fleet", "Connected fleets", "Company sign-in name", "Create invitation", "Copy invitation",
      "Advanced: connect with a pairing code", "Notices", "Acknowledge", "This Hub", "Hub name", "Set up a Hub", "Set up on this computer",
      "Test connection and review", "Create Hub", "Open Hub sign-in", "Checking whether the Hub is ready…", "Only the Hub administrator can see this",
      "已帶入加入碼。", "讓同仁加入", "以公司帳號登入", "恢復這次連接", "個別邀請", "還沒登入過 Hub", "停止分享", "分享的 Agent", "登入 Hub", "Hub 位址", "加入碼"];
    const notQuoted = labels.filter(l => !FLAT.includes(l)), notInUi = labels.filter(l => !SOURCES.includes(l));
    expect(notQuoted, "listed here but not in the skill").toEqual([]);
    expect(notInUi, "quoted by the skill but not a UI string").toEqual([]);
    // The CLI commands it names are the CLI's.
    const cli = source("src/cli.ts");
    expect(cli).toContain('program.command("hub")');
    expect(cli).toContain('hub.command("handoff")');
    for (const c of ["`agend hub init`", "`agend hub handoff`"]) expect(FLAT).toContain(c);
  });

  it("names only config keys the fleet reads, and marks what is not built", () => {
    const manager = source("src/fleet-manager.ts");
    for (const key of ["hub.enabled", "hub_member.enabled"]) expect(SKILL).toContain(`\`${key}\``);
    expect(manager).toContain("raw?.hub?.enabled === true || raw?.hub_member?.enabled === true");
    const notYet = SKILL.slice(SKILL.indexOf("\n## Not available yet\n"), SKILL.indexOf("\n## Troubleshooting\n"));
    for (const topic of ["Custom roles", "whole AD group to ask", "ClassicBot room", "Pause and resume", "second sign-in factor"]) expect(notYet, topic).toContain(topic);
  });

  it("carries no company specifics: placeholder addresses only", () => {
    expect(SKILL).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);                       // no IP address
    expect(SKILL).not.toMatch(/\b(?:DC|OU|CN)=/);                                               // no distinguished name
    expect(SKILL).not.toMatch(/ldaps?:\/\//i);                                                  // no directory server
    const hosts = [...SKILL.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|test|local|tw|io)\b/gi)].map(m => m[0].toLowerCase());
    expect([...new Set(hosts)]).toEqual(["hub.example.com"]);
  });

  it("agents are told once that the skill exists", () => {
    const entry = AGENT_WHATS_NEW.find(e => e.id === "2.4-hub-skill");
    expect(entry?.since).toBe("2.4.0-alpha.3");
    expect(entry?.text).toContain("`hub` skill");
  });
});
