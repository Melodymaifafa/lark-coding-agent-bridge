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

/** Run `fn` with `home` as the home directory, restoring the real one after. */
function withHome<T>(home: string, fn: () => T): T {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A sync bucket directory, named after account ids the way the real one is. */
function syncedBucket(home: string, bucket: string): string {
  const dir = join(home, '.claude', 'skills', 'synced', bucket);
  mkdirSync(dir, { recursive: true });
  // A zero-byte `.bucket-<ids>` marker sits beside the buckets; the scan has
  // to walk past it rather than treat it as a bucket.
  writeFileSync(join(home, '.claude', 'skills', 'synced', `.bucket-${bucket}`), '', 'utf8');
  return dir;
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

  it('describes the personal skill even when it has no description', () => {
    // Found-but-undescribed must still stop the lookup: falling through
    // would show the project namesake's text, or label the skill built-in.
    const home = join(root, 'home');
    writeSkill(join(home, '.claude', 'skills'), 'deploy', 'name: deploy');
    mkdirSync(join(home, '.claude', 'skills', 'notes'), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', 'notes', 'SKILL.md'), 'No frontmatter.\n');
    const cwd = join(root, 'proj');
    writeSkill(join(cwd, '.claude', 'skills'), 'deploy', 'description: Project deploy.');
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const specs = describeSkills({ names: ['deploy', 'notes'], plugins: [] }, cwd);
      expect(specs).toEqual([
        { name: 'deploy', origin: 'user' },
        { name: 'notes', origin: 'user' },
      ]);
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

  it('finds a skill renamed by frontmatter `name` in a differently named directory', () => {
    // Claude Code takes the command from frontmatter `name` when set, so
    // `deploy` can live in `deploy-staging/`. It must not read as built-in.
    const cwd = join(root, 'renamed');
    writeSkill(
      join(cwd, '.claude', 'skills'),
      'deploy-staging',
      'name: deploy\ndescription: Deploy to staging.',
    );
    const pluginPath = join(root, 'plugins', 'tools');
    writeSkill(join(pluginPath, 'skills'), 'review', 'name: "fancy"\ndescription: Fancy review.');

    const specs = describeSkills(
      { names: ['deploy', 'tools:fancy'], plugins: [{ name: 'tools', path: pluginPath }] },
      cwd,
    );
    expect(specs).toEqual([
      { name: 'deploy', summary: 'Deploy to staging.', origin: 'project' },
      { name: 'tools:fancy', summary: 'Fancy review.', plugin: 'tools', origin: 'plugin' },
    ]);
  });

  it('describes legacy command files, nested ones by their `:` path', () => {
    // Claude Code still loads `.claude/commands/*.md` as skills, and every
    // subdirectory adds a `:` segment to the name.
    const repo = join(root, 'cmds');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const commands = join(repo, '.claude', 'commands');
    mkdirSync(join(commands, 'frontend', 'mobile'), { recursive: true });
    writeFileSync(join(commands, 'ship-it.md'), '---\ndescription: Ship it.\n---\n\nbody\n');
    writeFileSync(
      join(commands, 'frontend', 'mobile', 'component.md'),
      '---\ndescription: Scaffold a mobile component.\n---\n\nbody\n',
    );
    writeFileSync(join(commands, 'bare-note.md'), 'No frontmatter at all.\n');
    const cwd = join(repo, 'packages', 'app');
    mkdirSync(cwd, { recursive: true });

    const specs = describeSkills(
      { names: ['ship-it', 'frontend:mobile:component', 'bare-note'], plugins: [] },
      cwd,
    );
    expect(specs).toEqual([
      { name: 'bare-note', origin: 'project' },
      {
        name: 'frontend:mobile:component',
        summary: 'Scaffold a mobile component.',
        origin: 'project',
      },
      { name: 'ship-it', summary: 'Ship it.', origin: 'project' },
    ]);
  });

  it('describes a skill over a same-named legacy command file', () => {
    const cwd = join(root, 'both');
    writeSkill(join(cwd, '.claude', 'skills'), 'tidy-up', 'description: Skill version.');
    mkdirSync(join(cwd, '.claude', 'commands'), { recursive: true });
    writeFileSync(
      join(cwd, '.claude', 'commands', 'tidy-up.md'),
      '---\ndescription: Command version.\n---\n',
    );

    const [spec] = describeSkills({ names: ['tidy-up'], plugins: [] }, cwd);
    expect(spec).toEqual({ name: 'tidy-up', summary: 'Skill version.', origin: 'project' });
  });

  it('resolves a plugin command file', () => {
    const pluginPath = join(root, 'plugins', 'ops');
    mkdirSync(join(pluginPath, 'commands'), { recursive: true });
    writeFileSync(
      join(pluginPath, 'commands', 'rollback.md'),
      '---\ndescription: Roll back.\n---\n',
    );

    const [spec] = describeSkills(
      { names: ['ops:rollback'], plugins: [{ name: 'ops', path: pluginPath }] },
      root,
    );
    expect(spec).toEqual({
      name: 'ops:rollback',
      summary: 'Roll back.',
      plugin: 'ops',
      origin: 'plugin',
    });
  });

  it("falls back to the main checkout's skills in a linked worktree without its own", () => {
    // Claude Code stops at the worktree root, then loads the main
    // checkout's project skills when the worktree has none.
    const main = join(root, 'main');
    const ownGitDir = join(main, '.git', 'worktrees', 'feature');
    mkdirSync(ownGitDir, { recursive: true });
    writeFileSync(join(ownGitDir, 'commondir'), '../..\n');
    writeSkill(join(main, '.claude', 'skills'), 'lint-all', 'description: Lint everything.');
    const worktree = join(root, 'feature');
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${ownGitDir}\n`);

    const [spec] = describeSkills({ names: ['lint-all'], plugins: [] }, join(worktree, 'src'));
    expect(spec).toEqual({ name: 'lint-all', summary: 'Lint everything.', origin: 'project' });
  });

  it('describes an account-synced skill from its SKILL.md, not as a plugin', () => {
    // `anthropic-skills:<x>` is the namespace Claude Code gives skills synced
    // from the account; no plugin by that name exists, so the old code labeled
    // them plugins with no summary.
    const home = join(root, 'synced-home');
    writeSkill(
      syncedBucket(home, 'acct-9f1_user-3c2'),
      'pdf',
      'name: pdf\ndescription: Work with PDF files.',
    );

    const specs = withHome(home, () =>
      describeSkills({ names: ['anthropic-skills:pdf'], plugins: [] }, join(root, 'proj')),
    );
    expect(specs).toEqual([
      { name: 'anthropic-skills:pdf', summary: 'Work with PDF files.', origin: 'synced' },
    ]);
  });

  it("falls back to a bucket's manifest.json when the skill's files are not on disk", () => {
    // Bucket names are account ids, so every bucket is searched — none of
    // them can be hardcoded.
    const home = join(root, 'manifest-home');
    syncedBucket(home, 'acct-aaa_user-111');
    const second = syncedBucket(home, 'acct-bbb_user-222');
    writeFileSync(
      join(second, 'manifest.json'),
      JSON.stringify({
        lastUpdated: 1,
        skills: [
          { skillId: 'skill_01', name: 'viral-hooks', description: 'Hooks that travel.' },
          { skillId: 'xlsx', name: 'xlsx', description: 'Spreadsheets.' },
        ],
      }),
      'utf8',
    );

    const specs = withHome(home, () =>
      describeSkills({ names: ['anthropic-skills:viral-hooks'], plugins: [] }, root),
    );
    expect(specs).toEqual([
      { name: 'anthropic-skills:viral-hooks', summary: 'Hooks that travel.', origin: 'synced' },
    ]);
  });

  it('marks a synced skill with no description anywhere as synced and summary-less', () => {
    // A synced name with nothing to read is still an account-synced skill:
    // the label must say so instead of claiming it is built into the CLI.
    const home = join(root, 'bare-home');
    syncedBucket(home, 'acct-ccc_user-333');

    const specs = withHome(home, () =>
      describeSkills({ names: ['anthropic-skills:schedule'], plugins: [] }, root),
    );
    expect(specs).toEqual([{ name: 'anthropic-skills:schedule', origin: 'synced' }]);
    expect(specs[0]?.summary).toBeUndefined();
  });

  it('still prefers a real plugin that happens to be named anthropic-skills', () => {
    const home = join(root, 'plugin-wins-home');
    writeSkill(syncedBucket(home, 'acct-ddd_user-444'), 'pdf', 'description: Synced copy.');
    const pluginPath = join(root, 'plugins', 'anthropic-skills');
    writeSkill(join(pluginPath, 'skills'), 'pdf', 'description: Plugin copy.');

    const specs = withHome(home, () =>
      describeSkills(
        {
          names: ['anthropic-skills:pdf'],
          plugins: [{ name: 'anthropic-skills', path: pluginPath }],
        },
        root,
      ),
    );
    expect(specs).toEqual([
      {
        name: 'anthropic-skills:pdf',
        summary: 'Plugin copy.',
        plugin: 'anthropic-skills',
        origin: 'plugin',
      },
    ]);
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

  it('matches names and descriptions, name hits first', () => {
    const cwd = join(root, 'match');
    const skills = join(cwd, '.claude', 'skills');
    writeSkill(skills, 'handoff', 'description: Write a session handoff note.');
    writeSkill(skills, 'diagnose', 'description: Debug a hard bug step by step.');
    writeSkill(skills, 'bug-report', 'description: File an issue.');
    const catalog = rememberSkillCatalog('claude', cwd, undefined, {
      names: ['handoff', 'diagnose', 'bug-report'],
      plugins: [],
    });

    expect(matchSkills(catalog, 'hand').map((s) => s.name)).toEqual(['handoff']);
    // A name hit must not hide a skill that only its description matches.
    expect(matchSkills(catalog, 'bug').map((s) => s.name)).toEqual(['bug-report', 'diagnose']);
    expect(matchSkills(catalog, '')).toHaveLength(3);
    expect(matchSkills(catalog, 'nothing-here')).toEqual([]);
  });

  it('caches per agent and cwd, and a later run replaces the entry', () => {
    const cwdA = join(root, 'a');
    const cwdB = join(root, 'b');
    mkdirSync(cwdA, { recursive: true });
    mkdirSync(cwdB, { recursive: true });

    rememberSkillCatalog('claude', cwdA, undefined, { names: ['one'], plugins: [] });
    rememberSkillCatalog('claude', cwdB, undefined, { names: ['one', 'two'], plugins: [] });

    expect(cachedSkillCatalog('claude', cwdA, undefined)?.skills).toHaveLength(1);
    expect(cachedSkillCatalog('claude', cwdB, undefined)?.skills).toHaveLength(2);
    expect(cachedSkillCatalog('codex', cwdA, undefined)).toBeUndefined();

    rememberSkillCatalog('claude', cwdA, undefined, {
      names: ['one', 'three', 'four'],
      plugins: [],
    });
    expect(cachedSkillCatalog('claude', cwdA, undefined)?.skills).toHaveLength(3);
  });

  it('keeps sessions sharing a cwd apart', () => {
    // A nested monorepo skill loads only in the session that touched its
    // directory, so one chat's list must not leak into another's.
    const cwd = join(root, 'mono');
    mkdirSync(cwd, { recursive: true });

    rememberSkillCatalog('claude', cwd, 'sess-a', {
      names: ['deploy', 'apps/web:deploy'],
      plugins: [],
    });
    rememberSkillCatalog('claude', cwd, 'sess-b', { names: ['deploy'], plugins: [] });

    expect(cachedSkillCatalog('claude', cwd, 'sess-a')?.skills).toHaveLength(2);
    expect(cachedSkillCatalog('claude', cwd, 'sess-b')?.skills).toHaveLength(1);
    expect(cachedSkillCatalog('claude', cwd, undefined)).toBeUndefined();
  });

  it('keys the cache on the resolved real path', () => {
    // The run flow caches under cwdRealpath while /skills may hold the
    // symlinked spelling; both must hit the same entry or every /skills
    // pays for a probe spawn.
    const real = mkdtempSync(join(tmpdir(), 'mel101-real-'));
    rememberSkillCatalog('claude', real, undefined, { names: ['one'], plugins: [] });
    const hit: SkillCatalog | undefined = cachedSkillCatalog(
      'claude',
      join(real, '.', ''),
      undefined,
    );
    expect(hit?.skills).toHaveLength(1);
  });
});
