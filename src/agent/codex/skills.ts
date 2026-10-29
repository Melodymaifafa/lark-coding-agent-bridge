/**
 * Codex's skills, read straight from disk. Codex reports no skill list on
 * any event, so the bridge scans the directories Codex loads skills from
 * (checked against `codex debug prompt-input`, codex-cli 0.162):
 * `.codex/skills` and `.agents/skills` in cwd and every parent up to the
 * repository root, `$CODEX_HOME/skills`, `~/.agents/skills`, and the bundled
 * `$CODEX_HOME/skills/.system`.
 *
 * A skill is a folder (or a symlink to one) holding a `SKILL.md`, possibly
 * nested in plain folders. Codex skips a `SKILL.md` without a frontmatter
 * `description`, so the bridge does too; `name` defaults to the folder's.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { readSkillFile, type SkillSpec } from '../../skills/registry';
import type { AgentSkillListing } from '../types';

/** How many plain folders deep a skill may sit below a skills directory. */
const MAX_NESTING = 6;

/**
 * Every directory Codex reads skills from for `cwd`, in priority order. A
 * name found in two of them is listed once, from the first.
 */
export function codexSkillRoots(cwd: string, codexHome: string): string[] {
  const project = projectDirs(cwd).flatMap((dir) => [
    join(dir, '.codex', 'skills'),
    join(dir, '.agents', 'skills'),
  ]);
  const user = join(codexHome, 'skills');
  return [...project, user, join(homedir(), '.agents', 'skills'), join(user, '.system')];
}

/**
 * The skills Codex has in `cwd` with `codexHome` as its home. Never throws:
 * a missing directory or unreadable file just contributes no skill.
 */
export function listCodexSkills(cwd: string, codexHome: string): AgentSkillListing {
  const searched = codexSkillRoots(cwd, codexHome);
  const byName = new Map<string, SkillSpec>();
  for (const root of searched) {
    for (const dir of skillDirs(root, 0)) {
      const file = readSkillFile(join(dir, 'SKILL.md'));
      if (!file?.summary) continue;
      const name = file.name ?? basename(dir);
      if (!byName.has(name)) byName.set(name, { name, summary: file.summary, origin: 'codex' });
    }
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { names: skills.map((s) => s.name), plugins: [], scanned: { skills, searched } };
}

/**
 * Skill folders under `dir`. Dot entries are skipped: `.system` is a root
 * of its own, and Codex leaves a `.codex-system-skills.marker` file there.
 */
function skillDirs(dir: string, depth: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (!isDirectory(path)) continue;
    if (existsSync(join(path, 'SKILL.md'))) found.push(path);
    else if (depth < MAX_NESTING) found.push(...skillDirs(path, depth + 1));
  }
  return found;
}

/** Follows symlinks: installed skills are often links into a shared store. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** cwd and each parent up to the repository root, nearest first; outside a repo, cwd alone. */
function projectDirs(cwd: string): string[] {
  const start = resolve(cwd);
  const dirs: string[] = [];
  for (let dir = start; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (existsSync(join(dir, '.git'))) return dirs;
    if (dirname(dir) === dir) return [start];
  }
}
