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
import { join } from 'node:path';
import type { AgentPluginRef, AgentSkillListing } from '../agent/types';

/** Where a skill's definition lives. Drives the label shown on the card. */
export type SkillOrigin = 'project' | 'user' | 'plugin' | 'builtin';

export interface SkillSpec {
  /** Exactly what the user types after the slash: `handoff`, `vercel:deploy`. */
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

/** Longest summary we keep; anything past this is elided on one line. */
const SUMMARY_MAX_CHARS = 110;

/**
 * Build specs for `listing.names`, resolving each one's `SKILL.md` summary.
 * Never throws: an unreadable or malformed `SKILL.md` just leaves the skill
 * without a summary rather than dropping it from the catalog.
 */
export function describeSkills(listing: AgentSkillListing, cwd: string): SkillSpec[] {
  const specs = listing.names.map((name) => describeSkill(name, listing.plugins, cwd));
  specs.sort((a, b) => a.name.localeCompare(b.name));
  return specs;
}

function describeSkill(name: string, plugins: readonly AgentPluginRef[], cwd: string): SkillSpec {
  const sep = name.indexOf(':');
  if (sep > 0) {
    const plugin = name.slice(0, sep);
    const bare = name.slice(sep + 1);
    for (const p of plugins) {
      if (p.name !== plugin) continue;
      const summary = readSkillSummary(join(p.path, 'skills', bare, 'SKILL.md'));
      if (summary !== undefined) return { name, summary, plugin, origin: 'plugin' };
    }
    return { name, plugin, origin: 'plugin' };
  }
  const projectSummary = readSkillSummary(join(cwd, '.claude', 'skills', name, 'SKILL.md'));
  if (projectSummary !== undefined) return { name, summary: projectSummary, origin: 'project' };
  const userSummary = readSkillSummary(join(homedir(), '.claude', 'skills', name, 'SKILL.md'));
  if (userSummary !== undefined) return { name, summary: userSummary, origin: 'user' };
  // No SKILL.md anywhere the bridge can reach: a skill Claude Code ships
  // inside its own binary.
  return { name, origin: 'builtin' };
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
