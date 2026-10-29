import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../../src/agent/codex/adapter.js';
import { listCodexSkills } from '../../../src/agent/codex/skills.js';

function writeSkill(root: string, dir: string, frontmatter: string): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nbody\n`, 'utf8');
}

describe('Codex skill listing', () => {
  let root: string;
  let home: string;
  let codexHome: string;
  let cwd: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mel514-codex-skills-'));
    home = join(root, 'home');
    codexHome = join(home, '.codex');
    cwd = join(root, 'repo');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    mkdirSync(home, { recursive: true });
    // Never read the developer's real `~/.codex` or `~/.agents`.
    saved = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      CODEX_HOME: process.env.CODEX_HOME,
    };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function adapter(opts: { codexHome?: string; inheritCodexHome?: boolean } = {}): CodexAdapter {
    return new CodexAdapter({ binary: 'codex', profileStateDir: join(root, 'state'), ...opts });
  }

  it("lists the skills in the user's ~/.codex/skills with name and summary", async () => {
    const skills = join(codexHome, 'skills');
    writeSkill(skills, 'handoff', 'name: handoff\ndescription: Write a session handoff note.');
    writeSkill(skills, 'diagnose', 'name: "diagnose"\ndescription: >-\n  Track down\n  a stubborn bug.');

    const listing = await adapter().listSkills(cwd);

    expect(listing.names).toEqual(['diagnose', 'handoff']);
    expect(listing.plugins).toEqual([]);
    expect(listing.scanned?.skills).toEqual([
      { name: 'diagnose', summary: 'Track down a stubborn bug.', origin: 'codex' },
      { name: 'handoff', summary: 'Write a session handoff note.', origin: 'codex' },
    ]);
  });

  it('includes the bundled .system skills and walks past their marker file', () => {
    const skills = join(codexHome, 'skills');
    writeSkill(join(skills, '.system'), 'imagegen', 'name: imagegen\ndescription: Make images.');
    writeFileSync(join(skills, '.system', '.codex-system-skills.marker'), 'v1\n', 'utf8');

    const listing = listCodexSkills(cwd, codexHome);

    expect(listing.names).toEqual(['imagegen']);
    expect(listing.scanned?.searched).toContain(join(skills, '.system'));
  });

  it('returns an empty list, without throwing, when the skills directory is missing', async () => {
    const listing = await adapter().listSkills(cwd);

    expect(listing.names).toEqual([]);
    expect(listing.scanned?.skills).toEqual([]);
    expect(listing.scanned?.searched).toContain(join(codexHome, 'skills'));
  });

  it('returns an empty list for an empty or dot-only skills directory', () => {
    mkdirSync(join(codexHome, 'skills', '.system'), { recursive: true });
    writeFileSync(join(codexHome, 'skills', '.DS_Store'), '', 'utf8');

    expect(listCodexSkills(cwd, codexHome).scanned?.skills).toEqual([]);
  });

  it('skips a SKILL.md without a description, as Codex does', () => {
    const skills = join(codexHome, 'skills');
    writeSkill(skills, 'named-only', 'name: named-only');
    mkdirSync(join(skills, 'no-frontmatter'), { recursive: true });
    writeFileSync(join(skills, 'no-frontmatter', 'SKILL.md'), 'just a body\n', 'utf8');
    writeSkill(skills, 'unnamed', 'description: Named after its folder.');

    expect(listCodexSkills(cwd, codexHome).scanned?.skills).toEqual([
      { name: 'unnamed', summary: 'Named after its folder.', origin: 'codex' },
    ]);
  });

  it('takes the frontmatter name, follows symlinks and finds nested skills', () => {
    const skills = join(codexHome, 'skills');
    writeSkill(skills, 'deploy-staging', 'name: deploy\ndescription: Ship it.');
    writeSkill(join(skills, 'team'), 'review', 'description: Review a diff.');
    writeSkill(join(root, 'store'), 'linked', 'description: Lives in a shared store.');
    // A junction needs no admin rights on Windows; elsewhere the type is ignored.
    symlinkSync(join(root, 'store', 'linked'), join(skills, 'linked'), 'junction');

    expect(listCodexSkills(cwd, codexHome).names).toEqual(['deploy', 'linked', 'review']);
  });

  it('reads project skills from cwd up to the repository root, nearest first', () => {
    const sub = join(cwd, 'packages', 'web');
    writeSkill(join(cwd, '.agents', 'skills'), 'lint', 'description: Repo lint.');
    writeSkill(join(cwd, '.codex', 'skills'), 'release', 'description: Repo release.');
    writeSkill(join(sub, '.agents', 'skills'), 'lint', 'description: Web lint.');
    writeSkill(join(home, '.agents', 'skills'), 'release', 'description: Personal release.');
    writeSkill(join(root, '.agents', 'skills'), 'outside', 'description: Above the repo.');

    expect(listCodexSkills(sub, codexHome).scanned?.skills).toEqual([
      { name: 'lint', summary: 'Web lint.', origin: 'codex' },
      { name: 'release', summary: 'Repo release.', origin: 'codex' },
    ]);
  });

  it("reads the skills of the CODEX_HOME the adapter's runs get", async () => {
    const configured = join(root, 'configured-home');
    writeSkill(join(configured, 'skills'), 'configured', 'description: From codexHome.');
    const isolated = join(root, 'state', 'codex-home');
    writeSkill(join(isolated, 'skills'), 'isolated', 'description: From the profile.');
    const inherited = join(root, 'inherited-home');
    writeSkill(join(inherited, 'skills'), 'inherited', 'description: From CODEX_HOME.');
    process.env.CODEX_HOME = inherited;

    expect((await adapter({ codexHome: configured }).listSkills(cwd)).names).toEqual(['configured']);
    expect((await adapter({ inheritCodexHome: false }).listSkills(cwd)).names).toEqual(['isolated']);
    expect((await adapter().listSkills(cwd)).names).toEqual(['inherited']);
  });
});
