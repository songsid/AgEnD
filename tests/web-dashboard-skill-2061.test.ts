/**
 * #2061: the `web-dashboard` knowledge skill — where things are on the web dashboard and what they do. It is published
 * on demand to General and workers (roles), covers every surface, and does not drift from the code: the numbers it
 * states are the code's, every `web.*` key it names exists, and it never gives the WSL advice the fleet forbids.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { UPLOAD_LIMITS, UPLOAD_MB_RANGE } from "../src/web-upload.js";
import { DEFAULT_SESSION_POLICY, MAX_WEB_SESSIONS } from "../src/web-session.js";
import { LOGIN_CODE_TTL_MS, MAX_LOGIN_CODE_ATTEMPTS } from "../src/web-login.js";
import { EFFECTIVE_TTL_WINDOW_MS } from "../src/cache-analysis.js";
import { TOOLS } from "../src/channel/mcp-tools.js";
import { previewOriginProblem } from "../src/web-preview.js";

const PATH = join(process.cwd(), "src/general-knowledge/skills/web-dashboard/SKILL.md");
const SKILL = readFileSync(PATH, "utf8");
const MB = 1024 * 1024, HOUR = 3_600_000;

describe("the web-dashboard skill", () => {
  it("has the skill frontmatter, for General, workers and ClassicBot agents (#2163)", () => {
    const m = SKILL.match(/^---\n([\s\S]*?)\n---\n/);
    expect(m, "frontmatter").toBeTruthy();
    const fm = parseDocument(m![1]!).toJS() as { name: string; description: string; roles: string[] };
    expect(fm.name).toBe("web-dashboard");
    expect(fm.description.length).toBeGreaterThan(40);
    expect(fm.description.length).toBeLessThan(400);
    expect(fm.roles).toEqual(["general", "worker", "classic"]);   // #2163: a ClassicBot room's agent too
  });

  it("is published to a worker's native skill directory, as one SKILL.md (the publisher copies nothing else)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-skill-2061-data-")), work = mkdtempSync(join(tmpdir(), "agend-skill-2061-work-"));
    try {
      const fm = new FleetManager(dataDir);
      (fm as any).fleetConfig = { web: { experimental: { canvas_worker: true } } };
      (fm as any).syncRoleSkills(work, "claude-code", "worker", join(process.cwd(), "src/general-knowledge"));
      const published = join(work, ".claude/skills/web-dashboard/SKILL.md");
      expect(existsSync(published), "published to the worker").toBe(true);
      expect(readFileSync(published, "utf8")).toBe(SKILL);
      expect((fm as any).readManagedSkillRoles(PATH)).toEqual(["general", "worker", "classic"]);
    } finally { rmSync(dataDir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
  });

  it("covers every surface, with an index pointing at real sections", () => {
    for (const h of ["Sign-in and access", "Chat", "Needs you", "Fleet", "Finding an instance", "Usage and the cache report", "The Log tab", "Settings", "Look", "Troubleshooting"]) {
      expect(SKILL, h).toContain(`\n## ${h}\n`);
    }
    const anchors = [...SKILL.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map(m => m[1]!);
    const slugs = [...SKILL.matchAll(/\n## (.+)\n/g)].map(m => m[1]!.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-"));
    expect(anchors.length).toBeGreaterThan(8);
    expect(anchors.filter(a => !slugs.includes(a))).toEqual([]);
    for (const tab of ["Preferences", "Look", "Agents", "Agent defaults", "Chat & connections", "Web dashboard", "Access & security", "Advanced"]) expect(SKILL, tab).toContain(`**${tab}**`);
    for (const t of ["Tasks", "Schedules", "Teams", "Org chart", "Cache"]) expect(SKILL, t).toContain(`**${t}**`);
  });

  it("its numbers are the code's", () => {
    expect(SKILL).toContain(`Up to ${UPLOAD_LIMITS.maxFiles} files, ${UPLOAD_LIMITS.maxFileBytes / MB} MB each, ${UPLOAD_LIMITS.maxTotalBytes / MB} MB per message`);
    expect(SKILL).toContain(`${UPLOAD_MB_RANGE.min}–${UPLOAD_MB_RANGE.max}`);
    expect(SKILL).toContain(`Local: ${DEFAULT_SESSION_POLICY.local.absoluteMs / HOUR} h from sign-in and ${DEFAULT_SESSION_POLICY.local.idleMs / HOUR} h unused`);
    expect(SKILL).toContain(`always ${DEFAULT_SESSION_POLICY.gateway.absoluteMs / HOUR} h / ${DEFAULT_SESSION_POLICY.gateway.idleMs / 60_000} min unused`);
    expect(SKILL).toContain(`At most ${MAX_WEB_SESSIONS} sessions`);
    expect(SKILL).toContain(`valid ${LOGIN_CODE_TTL_MS / 60_000} minutes, single use`);
    expect(SKILL).toContain(`${MAX_LOGIN_CODE_ATTEMPTS} wrong tries use it up`);
    expect(SKILL).toContain(`of the last ${EFFECTIVE_TTL_WINDOW_MS / 86_400_000}`);
  });

  it("names only web.* keys that exist, and only real tools", () => {
    const validator = readFileSync(join(process.cwd(), "src/config-validator.ts"), "utf8");
    const known = (validator.match(/const WEB_KEYS = \[([\s\S]*?)\]/)![1]!.match(/"([a-z_]+)"/g) ?? []).map(k => k.slice(1, -1));
    const named = [...new Set([...SKILL.matchAll(/`web\.([a-z_]+)/g)].map(m => m[1]!))];
    expect(named.length).toBeGreaterThan(8);
    expect(named.filter(k => !known.includes(k))).toEqual([]);
    const tools = new Set(TOOLS.map((t: { name: string }) => t.name));
    for (const t of ["get_cache_report", "get_usage", "get_fleet_config"]) { expect(tools.has(t), t).toBe(true); expect(SKILL).toContain(`\`${t}\``); }
  });

  it("keeps the dashboard's allowed_hosts and the preview origin apart, as the validator does (#2065 review)", () => {
    const trouble = SKILL.slice(SKILL.indexOf("**Preview \"connection refused\""), SKILL.indexOf("**Public link fails at once.**"));
    expect(trouble).toMatch(/\*\*dashboard's\*\* external name goes in `web\.allowed_hosts`/);
    expect(trouble).toMatch(/`web\.preview_origin` must be\s+a \*\*different\*\* host name/);
    expect(trouble).not.toMatch(/web\.preview_origin` and list the address in `web\.allowed_hosts`/);
    // The rule it states is the validator's: a preview origin the dashboard answers to is refused.
    expect(previewOriginProblem("https://dash.example.net", { web: { allowed_hosts: ["dash.example.net"] } } as never)).toMatch(/separate host name/);
    expect(previewOriginProblem("https://preview.example.net", { web: { allowed_hosts: ["dash.example.net"] } } as never)).toBeNull();
  });

  it("never tells anyone to kill wslrelay or shut WSL down, and names no real host or secret", () => {
    const wsl = SKILL.slice(SKILL.indexOf("**Blank dashboard"));
    expect(wsl).toMatch(/\*\*Do not\*\* tell the user to kill `wslrelay`\s+or run `wsl --shutdown`/);
    expect(SKILL).not.toMatch(/(?:^|\n)\s*-?\s*(?:run|use)\s+`wsl --shutdown`/i);
    expect(SKILL).not.toMatch(/https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(SKILL).not.toMatch(/[a-z0-9-]+\.trycloudflare\.com/i);
    expect(SKILL).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b(?<!127\.0\.0\.1)/);
    expect(SKILL).not.toMatch(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/);   // a bot token shape
  });

  // 2.3.0 stable (#1633): an agent on 2.3.0 is never told a feature is "2.3 beta" or to check for a beta version, in
  // either variant (the Canvas-Worker-off one is hand-maintained beside this one).
  it("names no beta version, in either variant", () => {
    const off = readFileSync(join(process.cwd(), "src/general-knowledge/skills/web-dashboard/SKILL.canvas-worker-off.md"), "utf8");
    expect([SKILL.match(/\bbeta\b[^\n]{0,40}/gi), off.match(/\bbeta\b[^\n]{0,40}/gi)]).toEqual([null, null]);
  });
});
