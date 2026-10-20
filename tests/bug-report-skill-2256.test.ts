import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FleetManager } from '../src/fleet-manager.js';

describe('bug report managed publication', () => {
  it.each([['codex', '.agents/skills'], ['claude-code', '.claude/skills'], ['kiro-cli', '.kiro/skills']])('publishes to General/coordinator through %s managed manifest and refreshes managed content', (backend, relative) => {
    const root = mkdtempSync(join(tmpdir(), 'agend-bug2256-skill-'));
    try {
      const fm = new FleetManager(join(root, 'data'));
      const sync = () => (fm as any).syncRoleSkills(root, backend, 'general', join(process.cwd(), 'src/general-knowledge'));
      sync();
      const skill = join(root, relative, 'bug-report', 'SKILL.md'), manifest = join(root, relative, '.agend-managed-skills.json');
      expect(JSON.parse(readFileSync(manifest, 'utf8'))).toContain('bug-report');
      expect(readFileSync(skill, 'utf8')).toBe(readFileSync('src/general-knowledge/skills/bug-report/SKILL.md', 'utf8'));
      writeFileSync(skill, 'obsolete managed content'); sync();
      expect(readFileSync(skill, 'utf8')).toContain('agend bug-report');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([false, true])('does not adopt a user-owned new skill as pre-manifest Kiro ownership (with legacy=%s)', withLegacy => {
    const root = mkdtempSync(join(tmpdir(), 'agend-bug2256-kiro-'));
    try {
      const skills = join(root, '.kiro/skills'), user = join(skills, 'bug-report/SKILL.md');
      mkdirSync(join(skills, 'bug-report'), { recursive: true }); writeFileSync(user, 'user-owned bug reporter');
      if (withLegacy) { mkdirSync(join(skills, 'fleet-health'), { recursive: true }); writeFileSync(join(skills, 'fleet-health/SKILL.md'), 'old user-edited health helper'); }
      const fm = new FleetManager(join(root, 'data'));
      (fm as any).syncRoleSkills(root, 'kiro-cli', 'general', join(process.cwd(), 'src/general-knowledge'));
      expect(readFileSync(user, 'utf8')).toBe('user-owned bug reporter');
      const manifest = JSON.parse(readFileSync(join(skills, '.agend-managed-skills.json'), 'utf8'));
      expect(manifest).not.toContain('bug-report');
      if (withLegacy) {
        expect(readFileSync(join(skills, 'fleet-health/SKILL.md'), 'utf8')).toBe('old user-edited health helper');
        expect(manifest).not.toContain('fleet-health');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('preserves user-owned collision and does not publish General-only reporting into worker/classic roles', () => {
    const root = mkdtempSync(join(tmpdir(), 'agend-bug2256-roles-'));
    try {
      const fm = new FleetManager(join(root, 'data'));
      for (const role of ['worker', 'classic']) {
        (fm as any).syncRoleSkills(join(root, role), 'codex', role, join(process.cwd(), 'src/general-knowledge'));
        expect(existsSync(join(root, role, '.agents/skills/bug-report/SKILL.md'))).toBe(false);
      }
      // Reuse the public sync guard with a real existing user-owned skill.
      const userSkill = join(root, 'general/.agents/skills/bug-report'); mkdirSync(userSkill, { recursive: true });
      writeFileSync(join(userSkill, 'SKILL.md'), 'user-owned report helper');
      (fm as any).syncRoleSkills(join(root, 'general'), 'codex', 'general', join(process.cwd(), 'src/general-knowledge'));
      expect(readFileSync(join(userSkill, 'SKILL.md'), 'utf8')).toBe('user-owned report helper');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
