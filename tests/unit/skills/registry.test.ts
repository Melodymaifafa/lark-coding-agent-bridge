import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cachedSkillCatalog,
  clearSkillCatalogs,
  describeSkills,
  matchSkills,
  rememberSkillCatalog,
  type SkillCatalog,
} from '../../../src/skills/registry.js';

function writeSkill(root: string, name: string, frontmatter: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nbody\n`, 'utf8');
}

describe('agent skill registry', () => {
  let root: string;

  beforeEach(() => {
    clearSkillCatalogs();
    root = mkdtempSync(join(tmpdir(), 'mel101-skills-'));
  });

  afterEach(() => {
    clearSkillCatalogs();
  });

  it('reads a one-line description from a project skill', () => {
    const cwd = join(root, 'proj');
    writeSkill(join(cwd, '.claude', 'skills'), 'deploy', 'name: deploy\ndescription: Ship the app.');

    const [spec] = describeSkills({ names: ['deploy'], plugins: [] }, cwd);
    expect(spec).toEqual({ name: 'deploy', summary: 'Ship the app.', origin: 'project' });
  });

  it('resolves a plugin skill through the plugin install path', () => {
    const pluginPath = join(root, 'plugins', 'vercel');
    writeSkill(join(pluginPath, 'skills'), 'deploy', 'description: Deploy to Vercel.');

    const [spec] = describeSkills(
      { names: ['vercel:deploy'], plugins: [{ name: 'vercel', path: pluginPath }] },
      root,
    );
    expect(spec).toEqual({
      name: 'vercel:deploy',
      summary: 'Deploy to Vercel.',
      plugin: 'vercel',
      origin: 'plugin',
    });
  });

  it('describes a personal skill over a same-named project skill', () => {
    // Claude Code resolves a shared name personal-first, so that is the
    // skill the run button invokes — the card must describe that one.
    const home = join(root, 'home');
    writeSkill(join(home, '.claude', 'skills'), 'deploy', 'description: Personal deploy.');
    const cwd = join(root, 'proj');
    writeSkill(join(cwd, '.claude', 'skills'), 'deploy', 'description: Project deploy.');
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const [spec] = describeSkills({ names: ['deploy'], plugins: [] }, cwd);
      expect(spec).toEqual({ name: 'deploy', summary: 'Personal deploy.', origin: 'user' });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('finds a project skill in a parent directory up to the repo root', () => {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeSkill(join(repo, '.claude', 'skills'), 'release', 'description: Cut a release.');
    const cwd = join(repo, 'packages', 'frontend');
    mkdirSync(cwd, { recursive: true });

    const [spec] = describeSkills({ names: ['release'], plugins: [] }, cwd);
    expect(spec).toEqual({ name: 'release', summary: 'Cut a release.', origin: 'project' });
  });

  it('resolves a directory-qualified nested skill as a project skill', () => {
    const repo = join(root, 'mono');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeSkill(
      join(repo, 'apps', 'web', '.claude', 'skills'),
      'deploy',
      'description: Deploy the web app.',
    );

    const [spec] = describeSkills({ names: ['apps/web:deploy'], plugins: [] }, repo);
    expect(spec).toEqual({
      name: 'apps/web:deploy',
      summary: 'Deploy the web app.',
      origin: 'project',
    });
  });

  it('keeps a skill with no SKILL.md on disk, marked built-in and summary-less', () => {
    // Claude Code compiles its own skills into the CLI binary, so there is
    // nothing to read. The skill must still be listed — dropping it would
    // under-report what the agent can do.
    const [spec] = describeSkills({ names: ['dataviz'], plugins: [] }, root);
    expect(spec).toEqual({ name: 'dataviz', origin: 'builtin' });
    expect(spec?.summary).toBeUndefined();
  });

  it('joins a wrapped / block-scalar description into one line', () => {
    const cwd = join(root, 'wrapped');
    writeSkill(
      join(cwd, '.claude', 'skills'),
      'wrapped',
      'description: >-\n  First half of the sentence\n  and the second half.\nname: wrapped',
    );
    writeSkill(
      join(cwd, '.claude', 'skills'),
      'quoted',
      'description: "Quoted   description."',
    );

    const specs = describeSkills({ names: ['wrapped', 'quoted'], plugins: [] }, cwd);
    expect(specs[1]?.summary).toBe('First half of the sentence and the second half.');
    expect(specs[0]?.summary).toBe('Quoted description.');
  });

  it('truncates a very long description to a single card line', () => {
    const cwd = join(root, 'long');
    writeSkill(join(cwd, '.claude', 'skills'), 'verbose', `description: ${'x'.repeat(400)}`);

    const [spec] = describeSkills({ names: ['verbose'], plugins: [] }, cwd);
    expect(spec?.summary?.length).toBeLessThanOrEqual(110);
    expect(spec?.summary?.endsWith('…')).toBe(true);
  });

  it('sorts the catalog by name', () => {
    const specs = describeSkills({ names: ['zeta', 'alpha', 'mid'], plugins: [] }, root);
    expect(specs.map((s) => s.name)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('matches by name first, then falls back to description text', () => {
    const cwd = join(root, 'match');
    const skills = join(cwd, '.claude', 'skills');
    writeSkill(skills, 'handoff', 'description: Write a session handoff note.');
    writeSkill(skills, 'diagnose', 'description: Debug a hard bug step by step.');
    const catalog = rememberSkillCatalog('claude', cwd, {
      names: ['handoff', 'diagnose'],
      plugins: [],
    });

    expect(matchSkills(catalog, 'hand').map((s) => s.name)).toEqual(['handoff']);
    // No name contains "bug", so the description is searched instead.
    expect(matchSkills(catalog, 'bug').map((s) => s.name)).toEqual(['diagnose']);
    expect(matchSkills(catalog, '')).toHaveLength(2);
    expect(matchSkills(catalog, 'nothing-here')).toEqual([]);
  });

  it('caches per agent and cwd, and a later run replaces the entry', () => {
    const cwdA = join(root, 'a');
    const cwdB = join(root, 'b');
    mkdirSync(cwdA, { recursive: true });
    mkdirSync(cwdB, { recursive: true });

    rememberSkillCatalog('claude', cwdA, { names: ['one'], plugins: [] });
    rememberSkillCatalog('claude', cwdB, { names: ['one', 'two'], plugins: [] });

    expect(cachedSkillCatalog('claude', cwdA)?.skills).toHaveLength(1);
    expect(cachedSkillCatalog('claude', cwdB)?.skills).toHaveLength(2);
    expect(cachedSkillCatalog('codex', cwdA)).toBeUndefined();

    rememberSkillCatalog('claude', cwdA, { names: ['one', 'three', 'four'], plugins: [] });
    expect(cachedSkillCatalog('claude', cwdA)?.skills).toHaveLength(3);
  });

  it('keys the cache on the resolved real path', () => {
    // The run flow caches under cwdRealpath while /skills may hold the
    // symlinked spelling; both must hit the same entry or every /skills
    // pays for a probe spawn.
    const real = mkdtempSync(join(tmpdir(), 'mel101-real-'));
    rememberSkillCatalog('claude', real, { names: ['one'], plugins: [] });
    const hit: SkillCatalog | undefined = cachedSkillCatalog('claude', join(real, '.', ''));
    expect(hit?.skills).toHaveLength(1);
  });
});
