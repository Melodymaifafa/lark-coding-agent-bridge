/**
 * Catalog of the **agent's** skills (Claude Code `/skill-name` entries) —
 * the counterpart to `src/commands/registry.ts`, which owns the bridge's
 * OWN slash commands. Two different data sources, deliberately separate:
 *
 * - bridge commands: a hand-written array we control (`COMMAND_REGISTRY`).
 * - agent skills: discovered at runtime from the agent, because the set
 *   depends on the user's plugins, their `~/.claude/skills`, and the cwd.
 *
 * Names come from the agent itself (Claude Code's stream-json `system/init`
 * event carries a `skills` array); one-line descriptions are read from each
 * skill's `SKILL.md` frontmatter. Claude Code's built-in skills are compiled
 * into the CLI binary and have no `SKILL.md` on disk — they keep their name
 * and carry `origin: 'builtin'` with no summary, so the card can say so
 * rather than silently showing a blank line.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AgentPluginRef, AgentSkillListing } from '../agent/types';

/** Where a skill's definition lives. Drives the label shown on the card. */
export type SkillOrigin = 'project' | 'user' | 'plugin' | 'builtin';

export interface SkillSpec {
  /**
   * Exactly what the user types after the slash: `handoff`, `vercel:deploy`,
   * or a nested monorepo skill like `apps/web:deploy`.
   */
  name: string;
  /** One-line description from `SKILL.md` frontmatter. Absent for built-ins. */
  summary?: string;
  /** Owning plugin, for `plugin:skill` names. */
  plugin?: string;
  origin: SkillOrigin;
}

export interface SkillCatalog {
  /** Sorted by name. */
  skills: readonly SkillSpec[];
  /** cwd the listing was captured for — the set is cwd-dependent. */
  cwd: string;
  /** Agent that produced it (`claude`). */
  agentId: string;
  capturedAt: number;
}

/**
 * `rawContentType` stamped on a `/skills` card run click queued for the
 * agent. Claude Code only treats `/<skill>` as an invocation when it is the
 * very start of the prompt, so the batch runner sends such a message bare
 * and on its own instead of wrapping it into a batch prompt. Not a Feishu
 * message type, so no inbound message can carry it.
 */
export const SKILL_RUN_CONTENT_TYPE = 'skill_run';

export function isSkillRunMessage(msg: { rawContentType: string }): boolean {
  return msg.rawContentType === SKILL_RUN_CONTENT_TYPE;
}

/** Longest summary we keep; anything past this is elided on one line. */
const SUMMARY_MAX_CHARS = 110;

/**
 * Build specs for `listing.names`, resolving each one's `SKILL.md` summary.
 * Never throws: an unreadable or malformed `SKILL.md` just leaves the skill
 * without a summary rather than dropping it from the catalog.
 */
export function describeSkills(listing: AgentSkillListing, cwd: string): SkillSpec[] {
  const roots = projectRoots(cwd);
  const specs = listing.names.map((name) => describeSkill(name, listing.plugins, roots));
  specs.sort((a, b) => a.name.localeCompare(b.name));
  return specs;
}

function describeSkill(
  name: string,
  plugins: readonly AgentPluginRef[],
  roots: readonly string[],
): SkillSpec {
  const sep = name.indexOf(':');
  if (sep > 0) {
    const prefix = name.slice(0, sep);
    const bare = name.slice(sep + 1);
    const owners = plugins.filter((p) => p.name === prefix);
    for (const p of owners) {
      const summary = readSkillSummary(join(p.path, 'skills', bare, 'SKILL.md'));
      if (summary !== undefined) return { name, summary, plugin: prefix, origin: 'plugin' };
    }
    if (owners.length === 0) {
      // Not a plugin: a directory-qualified nested project skill such as
      // `apps/web:deploy`, living in `apps/web/.claude/skills/deploy`.
      const summary = firstSummary(
        roots.map((root) => join(root, prefix, '.claude', 'skills', bare, 'SKILL.md')),
      );
      if (summary !== undefined) return { name, summary, origin: 'project' };
      // Plugin names never contain a slash.
      if (prefix.includes('/')) return { name, origin: 'project' };
    }
    return { name, plugin: prefix, origin: 'plugin' };
  }
  // Same-name precedence follows Claude Code: a personal skill overrides a
  // project one, so the summary shown is the one the click will run.
  const userSummary = readSkillSummary(join(homedir(), '.claude', 'skills', name, 'SKILL.md'));
  if (userSummary !== undefined) return { name, summary: userSummary, origin: 'user' };
  const projectSummary = firstSummary(
    roots.map((root) => join(root, '.claude', 'skills', name, 'SKILL.md')),
  );
  if (projectSummary !== undefined) return { name, summary: projectSummary, origin: 'project' };
  // No SKILL.md anywhere the bridge can reach: a skill Claude Code ships
  // inside its own binary.
  return { name, origin: 'builtin' };
}

/**
 * Directories whose `.claude/skills` hold project skills for `cwd`: Claude
 * Code loads them from cwd and every parent up to the repository root, so a
 * cwd of `packages/frontend` still sees the repo root's skills. Nearest
 * first. Outside a git repo only cwd itself counts.
 */
function projectRoots(cwd: string): string[] {
  const start = resolve(cwd);
  const roots: string[] = [];
  let dir = start;
  for (;;) {
    roots.push(dir);
    if (existsSync(join(dir, '.git'))) return roots;
    const parent = dirname(dir);
    if (parent === dir) return [start];
    dir = parent;
  }
}

function firstSummary(paths: readonly string[]): string | undefined {
  for (const path of paths) {
    const summary = readSkillSummary(path);
    if (summary !== undefined) return summary;
  }
  return undefined;
}

/**
 * Read the `description` field out of a `SKILL.md` YAML frontmatter block.
 * Returns undefined when the file is missing, has no frontmatter, or has no
 * description — all three mean "no summary available", never an error.
 */
function readSkillSummary(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return undefined;
  const raw = extractDescription(block[1] ?? '');
  if (!raw) return undefined;
  return condense(raw);
}

/**
 * Minimal frontmatter reader for the one key we need. Handles `description:
 * text`, quoted values, and YAML block/continuation lines (`>-`, `|`, or a
 * plain indented wrap). Stops at the next top-level key.
 */
function extractDescription(front: string): string {
  const lines = front.split(/\r?\n/);
  const parts: string[] = [];
  let collecting = false;
  for (const line of lines) {
    const key = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (key) {
      if (collecting) break;
      if (key[1]?.toLowerCase() !== 'description') continue;
      collecting = true;
      const inline = (key[2] ?? '').trim();
      // `>-` / `|` introduce a block scalar; the value is on the next lines.
      if (inline && !/^[>|][-+]?$/.test(inline)) parts.push(inline);
      continue;
    }
    if (!collecting) continue;
    if (!line.trim()) continue;
    if (!/^[ \t]/.test(line)) break;
    parts.push(line.trim());
  }
  return parts.join(' ').trim();
}

/** Strip wrapping quotes, collapse whitespace, cut to a single card line. */
function condense(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (s.length <= SUMMARY_MAX_CHARS) return s;
  return `${s.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Skills whose name or summary contains `query` (case-insensitive). An empty
 * query returns the whole catalog — callers decide how many to render.
 */
export function matchSkills(catalog: SkillCatalog, query: string): SkillSpec[] {
  const needle = query.replace(/^\//, '').trim().toLowerCase();
  if (!needle) return [...catalog.skills];
  const byName = catalog.skills.filter((s) => s.name.toLowerCase().includes(needle));
  if (byName.length > 0) return byName;
  return catalog.skills.filter((s) => (s.summary ?? '').toLowerCase().includes(needle));
}

// ---------------------------------------------------------------------------
// Cache
//
// Claude Code emits the skill list on EVERY run's `system/init` event, so a
// normal chat turn refreshes this for free. `/skills` only pays for a probe
// spawn when the scope has never run the agent in this cwd.
// ---------------------------------------------------------------------------

const catalogs = new Map<string, SkillCatalog>();

/**
 * Key on the resolved real path: the run flow caches under the realpath
 * (and claude reports `/private/var/...` for a `/var/...` symlink), while a
 * `/cd`-configured path may still be the symlinked spelling. Without this
 * the two never match and `/skills` re-probes on every call.
 */
function cacheKey(agentId: string, cwd: string): string {
  let resolved = cwd;
  try {
    resolved = realpathSync(cwd);
  } catch {
    // Directory gone or unreadable — key on the literal path instead.
  }
  return `${agentId}\u0000${resolved}`;
}

/** Record a listing observed on a live run. Returns the catalog it built. */
export function rememberSkillCatalog(
  agentId: string,
  cwd: string,
  listing: AgentSkillListing,
): SkillCatalog {
  const catalog: SkillCatalog = {
    skills: describeSkills(listing, cwd),
    cwd,
    agentId,
    capturedAt: Date.now(),
  };
  catalogs.set(cacheKey(agentId, cwd), catalog);
  return catalog;
}

export function cachedSkillCatalog(agentId: string, cwd: string): SkillCatalog | undefined {
  return catalogs.get(cacheKey(agentId, cwd));
}

/** Test seam — the cache is process-global. */
export function clearSkillCatalogs(): void {
  catalogs.clear();
}
