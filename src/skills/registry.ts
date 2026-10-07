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
 * skill's `SKILL.md` frontmatter, or from a legacy `.claude/commands/*.md`
 * file, which Claude Code still loads as a skill. Claude Code's built-in
 * skills are compiled into the CLI binary and have no `SKILL.md` on disk —
 * they keep their name and carry `origin: 'builtin'` with no summary, so the
 * card can say so rather than silently showing a blank line. Skills synced
 * from the user's account are reported under a namespace that is no plugin
 * (`anthropic-skills:pdf`) and read from `~/.claude/skills/synced/`.
 */
import type { NormalizedMessage } from '@larksuite/channel';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { AgentPluginRef, AgentSkillListing } from '../agent/types';

/** Where a skill's definition lives. Drives the label shown on the card. */
export type SkillOrigin = 'project' | 'user' | 'plugin' | 'builtin' | 'synced';

/**
 * Namespace Claude Code gives skills synced from the user's Anthropic
 * account. It looks like a plugin prefix but is not one — the init event's
 * `plugins` never carries it and nothing under `~/.claude/plugins` is named
 * that — so its skills are read from `~/.claude/skills/synced/` instead. A
 * real plugin by this name still loads, but Claude Code runs the synced skill
 * when both have one by the same name, so the plugin copy is described only
 * when no synced namesake exists.
 */
const SYNCED_SKILL_NAMESPACE = 'anthropic-skills';

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
  /** Claude session the listing belongs to; absent for a fresh session. */
  sessionId?: string;
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

/** Where a `/skills` card listed its skills: a cwd and, once run, a session. */
export interface SkillCardScope {
  cwd?: string;
  session?: string;
}

/**
 * A queued run click. `listedFor` is its card's scope, re-checked right
 * before the run starts: the click may wait behind a run, and `/ws use`,
 * `/new` or `/resume` can move the scope meanwhile.
 */
export type SkillRunMessage = NormalizedMessage & { listedFor: SkillCardScope };

export function isSkillRunMessage(msg: NormalizedMessage): msg is SkillRunMessage {
  return msg.rawContentType === SKILL_RUN_CONTENT_TYPE;
}

export type SkillCardStaleness = 'cwd' | 'session';

/**
 * Why a card listed for `listed` must not run a skill in `current`, if it
 * mustn't. In another cwd the same name could be a different skill or none
 * at all; nested monorepo skills load per session, so a card listed in one
 * session is stale after `/new` or `/resume`. A card listed before the
 * scope's first run carries no session — that fresh set is what every
 * session in this cwd starts with, so it stays valid.
 */
export function skillCardStaleness(
  listed: SkillCardScope,
  current: SkillCardScope,
): SkillCardStaleness | undefined {
  if (!listed.cwd || listed.cwd !== current.cwd) return 'cwd';
  if (listed.session && listed.session !== current.session) return 'session';
  return undefined;
}

/** What the user is told when a stale card's run click is refused. */
export const STALE_SKILL_CARD_NOTICE: Record<SkillCardStaleness, string> = {
  cwd: '⚠️ 这张技能卡是在另一个工作目录下列出的，当前目录已经变了，没有运行。请重新发送 `/skills` 再点。',
  session: '⚠️ 这张技能卡是在之前的会话里列出的，现在已经换了会话，没有运行。请重新发送 `/skills` 再点。',
};

/** Longest summary we keep; anything past this is elided on one line. */
const SUMMARY_MAX_CHARS = 110;

/**
 * Build specs for `listing.names`, resolving each one's `SKILL.md` summary.
 * Never throws: an unreadable or malformed `SKILL.md` just leaves the skill
 * without a summary rather than dropping it from the catalog.
 */
export function describeSkills(listing: AgentSkillListing, cwd: string): SkillSpec[] {
  const roots = projectRoots(cwd);
  const lookup = skillLookup();
  const specs = listing.names.map((name) => describeSkill(name, listing.plugins, roots, lookup));
  specs.sort((a, b) => a.name.localeCompare(b.name));
  return specs;
}

function describeSkill(
  name: string,
  plugins: readonly AgentPluginRef[],
  roots: readonly string[],
  lookup: SkillLookup,
): SkillSpec {
  const sep = name.indexOf(':');
  if (sep > 0) {
    const prefix = name.slice(0, sep);
    const bare = name.slice(sep + 1);
    // The reserved full name runs the synced skill even when a plugin by
    // that name has a namesake, so the card must describe the synced copy.
    if (prefix === SYNCED_SKILL_NAMESPACE) {
      const synced = findSyncedSkill(bare);
      if (synced) return { name, ...synced, origin: 'synced' };
    }
    const owners = plugins.filter((p) => p.name === prefix);
    for (const p of owners) {
      // A plugin's `commands/*.md` files are skills too.
      const found =
        lookup(join(p.path, 'skills'), bare) ?? readCommandFile(join(p.path, 'commands'), bare);
      if (found) return { name, ...found, plugin: prefix, origin: 'plugin' };
    }
    if (owners.length === 0) {
      // Not a plugin: a skill synced from the account, even with nothing
      // under `skills/synced/` to read — the name already says it exists.
      if (prefix === SYNCED_SKILL_NAMESPACE) return { name, origin: 'synced' };
      // Or a directory-qualified nested project skill such as
      // `apps/web:deploy`, living in `apps/web/.claude/skills/deploy` —
      // named after its directory, so no frontmatter rename applies.
      const found = firstFound(roots, (root) =>
        findSkillFile(join(root, prefix, '.claude', 'skills', bare, 'SKILL.md')),
      );
      if (found) return { name, ...found, origin: 'project' };
      // Or a legacy command in a subdirectory: `frontend:component` is
      // `.claude/commands/frontend/component.md`.
      const command = findCommand(name, roots);
      if (command) return { name, ...command };
      // Plugin names never contain a slash.
      if (prefix.includes('/')) return { name, origin: 'project' };
    }
    return { name, plugin: prefix, origin: 'plugin' };
  }
  // Same-name precedence follows Claude Code: a personal skill overrides a
  // project one, so the summary shown is the one the click will run. A
  // found skill without a description still wins — never fall through to a
  // lower-priority namesake's summary, or to built-in.
  const user = lookup(join(homedir(), '.claude', 'skills'), name);
  if (user) return { name, ...user, origin: 'user' };
  const project = firstFound(roots, (root) => lookup(join(root, '.claude', 'skills'), name));
  if (project) return { name, ...project, origin: 'project' };
  // A skill beats a same-named legacy command file, so commands come last.
  const command = findCommand(name, roots);
  if (command) return { name, ...command };
  // No SKILL.md or command file anywhere the bridge can reach: a skill
  // Claude Code ships inside its own binary.
  return { name, origin: 'builtin' };
}

/**
 * The legacy command file invoked as `name`, personal before project like
 * skills. Found even without a description — it is a real command, so it
 * must not read as built-in.
 */
function findCommand(
  name: string,
  roots: readonly string[],
): (SkillFound & { origin: 'user' | 'project' }) | undefined {
  const personal = readCommandFile(join(homedir(), '.claude', 'commands'), name);
  if (personal) return { ...personal, origin: 'user' };
  for (const root of roots) {
    const project = readCommandFile(join(root, '.claude', 'commands'), name);
    if (project) return { ...project, origin: 'project' };
  }
  return undefined;
}

/**
 * Read the command file invoked as `name` from one `commands` directory.
 * Its name is its path there with each `/` turned into `:` —
 * `frontend/component.md` is `frontend:component` — and command files take
 * no frontmatter `name`, so the path alone locates it.
 */
function readCommandFile(commandsDir: string, name: string): SkillFound | undefined {
  return findSkillFile(`${join(commandsDir, ...name.split(':'))}.md`);
}

/**
 * Summary for an account-synced skill invoked as `anthropic-skills:<bare>`.
 * Each sync bucket is a directory named after account ids, so all of them are
 * searched rather than any one name being hardcoded; a zero-byte
 * `.bucket-<ids>` marker sits beside them and is skipped. The skill's own
 * `SKILL.md` wins; a bucket's `manifest.json` — the catalog of what the
 * account holds — covers a skill whose files have not been pulled down.
 * Undefined when no bucket has the skill's folder or lists it, so a plugin
 * named after the namespace can still describe its own skill.
 */
function findSyncedSkill(bare: string): SkillFound | undefined {
  const synced = join(homedir(), '.claude', 'skills', 'synced');
  let buckets: string[];
  try {
    buckets = readdirSync(synced).sort();
  } catch {
    return undefined;
  }
  let onDisk: SkillFound | undefined;
  let fromManifest: SkillFound | undefined;
  for (const bucket of buckets) {
    if (bucket.startsWith('.')) continue;
    const file = findSkillFile(join(synced, bucket, bare, 'SKILL.md'));
    if (file?.summary !== undefined) return file;
    onDisk ??= file;
    fromManifest ??= manifestSummary(join(synced, bucket, 'manifest.json'), bare);
  }
  return fromManifest ?? onDisk;
}

/**
 * `description` for `bare` in one sync bucket's `manifest.json`. Undefined
 * when the file is missing, unparseable, or lists no such skill — so the
 * search moves on to the next bucket.
 */
function manifestSummary(path: string, bare: string): SkillFound | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const skills = (parsed as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return undefined;
  for (const entry of skills) {
    if (typeof entry !== 'object' || entry === null) continue;
    const skill = entry as { name?: unknown; description?: unknown };
    if (skill.name !== bare) continue;
    return typeof skill.description === 'string' && skill.description.trim()
      ? { summary: condense(skill.description) }
      : {};
  }
  return undefined;
}

/**
 * Directories whose `.claude/skills` hold project skills for `cwd`: Claude
 * Code loads them from cwd and every parent up to the repository root, so a
 * cwd of `packages/frontend` still sees the repo root's skills. Nearest
 * first. Outside a git repo only cwd itself counts. A linked git worktree
 * whose root has no `.claude/skills` loads the main checkout's instead, so
 * that checkout comes last.
 */
function projectRoots(cwd: string): string[] {
  const start = resolve(cwd);
  const roots: string[] = [];
  let dir = start;
  for (;;) {
    roots.push(dir);
    if (existsSync(join(dir, '.git'))) {
      if (!existsSync(join(dir, '.claude', 'skills'))) {
        const main = mainCheckoutOf(dir);
        if (main && main !== dir) roots.push(main);
      }
      return roots;
    }
    const parent = dirname(dir);
    if (parent === dir) return [start];
    dir = parent;
  }
}

/**
 * Main checkout of the linked git worktree rooted at `root`. A linked
 * worktree's `.git` is a file pointing at its own gitdir, whose `commondir`
 * names the main checkout's `.git`. Undefined for a normal checkout (`.git`
 * is a directory), a submodule (no `commondir`), or a bare main repository.
 */
function mainCheckoutOf(root: string): string | undefined {
  try {
    const pointer = /^gitdir:[ \t]*(.+)$/m.exec(readFileSync(join(root, '.git'), 'utf8'));
    const gitDir = pointer?.[1]?.trim();
    if (!gitDir) return undefined;
    const ownDir = resolve(root, gitDir);
    const commonDir = resolve(ownDir, readFileSync(join(ownDir, 'commondir'), 'utf8').trim());
    return basename(commonDir) === '.git' ? dirname(commonDir) : undefined;
  } catch {
    return undefined;
  }
}

function firstFound(
  roots: readonly string[],
  read: (root: string) => SkillFound | undefined,
): SkillFound | undefined {
  for (const root of roots) {
    const found = read(root);
    if (found) return found;
  }
  return undefined;
}

/**
 * A skill or command file that exists. `summary` is absent when it has no
 * description — still found, so the lookup must stop here rather than fall
 * through to a lower-priority namesake or to built-in.
 */
interface SkillFound {
  summary?: string;
}

function skillFound(file: { summary?: string }): SkillFound {
  return file.summary !== undefined ? { summary: file.summary } : {};
}

function findSkillFile(path: string): SkillFound | undefined {
  const file = readSkillFile(path);
  return file && skillFound(file);
}

/** The skill invoked as `name` in one `skills` directory, if it is there. */
type SkillLookup = (skillsDir: string, name: string) => SkillFound | undefined;

/**
 * A personal, project or plugin skill takes its command name from the
 * frontmatter `name` when set, else from its directory — so a reported
 * `deploy` may live in `deploy-staging/` with `name: deploy`. The
 * same-named directory is tried first; each directory's renamed entries
 * are scanned once per describe pass.
 */
function skillLookup(): SkillLookup {
  const renamedByDir = new Map<string, Map<string, SkillFound>>();
  return (skillsDir, name) => {
    const direct = readSkillFile(join(skillsDir, name, 'SKILL.md'));
    if (direct && (direct.name === undefined || direct.name === name)) return skillFound(direct);
    let renamed = renamedByDir.get(skillsDir);
    if (!renamed) {
      renamed = renamedSkills(skillsDir);
      renamedByDir.set(skillsDir, renamed);
    }
    // The directory name still invokes a renamed skill, so fall back to it.
    return renamed.get(name) ?? (direct && skillFound(direct));
  };
}

/** Frontmatter `name` → skill, for skills whose `name` isn't their directory's. */
function renamedSkills(skillsDir: string): Map<string, SkillFound> {
  const renamed = new Map<string, SkillFound>();
  let entries: string[];
  try {
    entries = readdirSync(skillsDir).sort();
  } catch {
    return renamed;
  }
  for (const entry of entries) {
    const skill = readSkillFile(join(skillsDir, entry, 'SKILL.md'));
    if (skill?.name && skill.name !== entry && !renamed.has(skill.name)) {
      renamed.set(skill.name, skillFound(skill));
    }
  }
  return renamed;
}

/**
 * Read `name` and `description` out of a `SKILL.md` YAML frontmatter block.
 * Returns undefined only when the file is missing: an unreadable file, one
 * with no frontmatter, or a field that isn't there just leaves that field
 * absent — "no summary available", never "no such skill".
 */
function readSkillFile(path: string): { name?: string; summary?: string } | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return {};
  const front = block[1] ?? '';
  const name = unquote(extractField(front, 'name'));
  const description = extractField(front, 'description');
  return {
    ...(name ? { name } : {}),
    ...(description ? { summary: condense(description) } : {}),
  };
}

/**
 * Minimal frontmatter reader for the few keys we need. Handles `key: text`,
 * quoted values, and YAML block/continuation lines (`>-`, `|`, or a plain
 * indented wrap). Stops at the next top-level key.
 */
function extractField(front: string, field: string): string {
  const lines = front.split(/\r?\n/);
  const parts: string[] = [];
  let collecting = false;
  for (const line of lines) {
    const key = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (key) {
      if (collecting) break;
      if (key[1]?.toLowerCase() !== field) continue;
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

/** Strip one pair of wrapping quotes. */
function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

/** Strip wrapping quotes, collapse whitespace, cut to a single card line. */
function condense(raw: string): string {
  const s = unquote(raw.replace(/\s+/g, ' ').trim());
  if (s.length <= SUMMARY_MAX_CHARS) return s;
  return `${s.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Skills whose name or summary contains `query` (case-insensitive), name
 * matches first so the closest hits survive the card's row cap. An empty
 * query returns the whole catalog — callers decide how many to render.
 */
export function matchSkills(catalog: SkillCatalog, query: string): SkillSpec[] {
  const needle = query.replace(/^\//, '').trim().toLowerCase();
  if (!needle) return [...catalog.skills];
  const nameHit = (s: SkillSpec): boolean => s.name.toLowerCase().includes(needle);
  const byName = catalog.skills.filter(nameHit);
  const bySummary = catalog.skills.filter(
    (s) => !nameHit(s) && (s.summary ?? '').toLowerCase().includes(needle),
  );
  return [...byName, ...bySummary];
}

// ---------------------------------------------------------------------------
// Cache
//
// Claude Code emits the skill list on EVERY run's `system/init` event, so a
// normal chat turn refreshes its session's entry for free. Entries are per
// Claude session: skills nested below the startup directory load only once
// that session touches their directory, so two chats in one monorepo can see
// different lists. `/skills` only pays for a probe spawn when neither the
// chat's current session nor the cwd's fresh-session list is cached; a probe
// is itself a fresh session, so it is only ever cached as one. Runs never
// refresh that fresh-session entry (their init always names a session), so
// it expires instead — see `FRESH_CATALOG_TTL_MS`.
// ---------------------------------------------------------------------------

const catalogs = new Map<string, SkillCatalog>();

/** Oldest entries are dropped past this many, so a long-lived daemon stays bounded. */
const MAX_CATALOGS = 200;

/**
 * How long a fresh-session (probe) list is reused before `/skills` probes
 * again. Without it a chat with no session — e.g. right after `/new` — would
 * keep the first probe's list for the bridge's whole lifetime: a skill
 * installed later never shows up, and a deleted one keeps its run button.
 * Long enough that a few keyword searches in a row share one probe.
 */
export const FRESH_CATALOG_TTL_MS = 60_000;

/**
 * Key on the resolved real path: the run flow caches under the realpath
 * (and claude reports `/private/var/...` for a `/var/...` symlink), while a
 * `/cd`-configured path may still be the symlinked spelling. Without this
 * the two never match and `/skills` re-probes on every call.
 */
function cacheKey(agentId: string, cwd: string, sessionId: string | undefined): string {
  let resolved = cwd;
  try {
    resolved = realpathSync(cwd);
  } catch {
    // Directory gone or unreadable — key on the literal path instead.
  }
  return `${agentId}\u0000${resolved}\u0000${sessionId ?? ''}`;
}

/**
 * Record a listing for `sessionId` (undefined: a session that hasn't
 * started yet). Returns the catalog it built.
 */
export function rememberSkillCatalog(
  agentId: string,
  cwd: string,
  sessionId: string | undefined,
  listing: AgentSkillListing,
): SkillCatalog {
  const catalog: SkillCatalog = {
    skills: describeSkills(listing, cwd),
    cwd,
    agentId,
    ...(sessionId ? { sessionId } : {}),
    capturedAt: Date.now(),
  };
  const key = cacheKey(agentId, cwd, sessionId);
  // Re-insert so Map order tracks recency and eviction drops the stalest.
  catalogs.delete(key);
  catalogs.set(key, catalog);
  if (catalogs.size > MAX_CATALOGS) {
    const oldest = catalogs.keys().next().value;
    if (oldest !== undefined) catalogs.delete(oldest);
  }
  return catalog;
}

export function cachedSkillCatalog(
  agentId: string,
  cwd: string,
  sessionId: string | undefined,
): SkillCatalog | undefined {
  const key = cacheKey(agentId, cwd, sessionId);
  const catalog = catalogs.get(key);
  if (catalog && !sessionId && Date.now() - catalog.capturedAt >= FRESH_CATALOG_TTL_MS) {
    catalogs.delete(key);
    return undefined;
  }
  return catalog;
}

/** Test seam — the cache is process-global. */
export function clearSkillCatalogs(): void {
  catalogs.clear();
}
