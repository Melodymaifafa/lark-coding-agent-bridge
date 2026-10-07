import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { COMMAND_REGISTRY } from '../../../src/commands/registry.js';
import { SKILLS_CARD_LIMIT } from '../../../src/card/templates.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { SessionStore } from '../../../src/session/store.js';
import {
  cachedSkillCatalog,
  clearSkillCatalogs,
  FRESH_CATALOG_TTL_MS,
  rememberSkillCatalog,
} from '../../../src/skills/registry.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeSkillSource } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('/skills — agent skill discovery', () => {
  beforeEach(() => clearSkillCatalogs());

  afterEach(async () => {
    clearSkillCatalogs();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('is advertised in the bridge command registry', () => {
    const spec = COMMAND_REGISTRY.find((c) => c.name === 'skills');
    expect(spec?.summary).toBeTruthy();
    expect(spec?.admin).toBeFalsy();
  });

  it('lists each skill with its name and a one-line description', async () => {
    const h = await createHarness({
      skills: { names: ['handoff', 'diagnose'], plugins: [] },
    });
    await writeProjectSkill(h.cwd, 'handoff', '写一份 session 交接记录。');
    await writeProjectSkill(h.cwd, 'diagnose', '一步步定位难查的 bug。');

    await expect(h.run('/skills')).resolves.toBe(true);
    const card = JSON.stringify(h.lastCard());

    expect(card).toContain('/handoff');
    expect(card).toContain('写一份 session 交接记录。');
    expect(card).toContain('/diagnose');
    expect(card).toContain('一步步定位难查的 bug。');
    // Every entry offers a click-to-run button.
    expect(card).toContain('"cmd":"skills.run"');
    expect(card).toContain('"arg":"handoff"');
    // …bound to the cwd it was listed for, so a click after `/cd` is caught.
    expect(card).toContain(`"cwd":${JSON.stringify(h.cwd)}`);
    expect(h.agent.listSkillsCalls).toHaveLength(1);
  });

  it('filters by keyword across names and descriptions', async () => {
    const h = await createHarness({
      skills: { names: ['handoff', 'diagnose'], plugins: [] },
    });
    await writeProjectSkill(h.cwd, 'handoff', 'Write a session handoff note.');
    await writeProjectSkill(h.cwd, 'diagnose', 'Track down a stubborn bug.');

    await expect(h.run('/skills bug')).resolves.toBe(true);
    const card = JSON.stringify(h.lastCard());
    expect(card).toContain('/diagnose');
    expect(card).not.toContain('"arg":"handoff"');
  });

  it('caps the card and tells the user how to narrow down', async () => {
    // Zero-padded so lexicographic order matches numeric order.
    const names = Array.from(
      { length: SKILLS_CARD_LIMIT + 5 },
      (_, i) => `skill-${String(i).padStart(2, '0')}`,
    );
    const h = await createHarness({ skills: { names, plugins: [] } });

    await expect(h.run('/skills')).resolves.toBe(true);
    const card = JSON.stringify(h.lastCard());
    expect(card).toContain(`${names.length}`);
    expect(card).toContain('关键词');
    expect(card).toContain('"arg":"skill-00"');
    expect(card).not.toContain('"arg":"skill-14"');
  });

  it('reuses the list an earlier run already reported, without re-probing', async () => {
    const h = await createHarness({
      skills: { names: ['probed'], plugins: [] },
    });
    // Same thing channel.ts does when it sees a run's init event.
    h.sessions.set('chat-1', 'sess-1', h.cwd);
    rememberSkillCatalog(h.agent.id, h.cwd, 'sess-1', { names: ['from-run'], plugins: [] });

    await expect(h.run('/skills')).resolves.toBe(true);
    expect(JSON.stringify(h.lastCard())).toContain('/from-run');
    expect(h.agent.listSkillsCalls).toHaveLength(0);
  });

  it("does not show another session's list for the same cwd", async () => {
    const h = await createHarness({
      skills: { names: ['probed'], plugins: [] },
    });
    // Another chat's session in this cwd loaded a nested skill this chat's
    // session never touched.
    rememberSkillCatalog(h.agent.id, h.cwd, 'other-sess', {
      names: ['apps/web:deploy'],
      plugins: [],
    });

    await expect(h.run('/skills')).resolves.toBe(true);
    const card = JSON.stringify(h.lastCard());
    expect(card).toContain('/probed');
    expect(card).not.toContain('apps/web:deploy');
    expect(h.agent.listSkillsCalls).toHaveLength(1);
  });

  it("binds each run button to the chat's session", async () => {
    const h = await createHarness({ skills: { names: ['probed'], plugins: [] } });
    h.sessions.set('chat-1', 'sess-1', h.cwd);
    rememberSkillCatalog(h.agent.id, h.cwd, 'sess-1', { names: ['from-run'], plugins: [] });

    await expect(h.run('/skills')).resolves.toBe(true);
    const card = JSON.stringify(h.lastCard());
    expect(card).toContain('"session":"sess-1"');
    expect(card).not.toContain('没列全');
  });

  it("does not pin a fresh probe to the chat's existing session", async () => {
    const h = await createHarness({ skills: { names: ['probed'], plugins: [] } });
    // After a bridge restart: the chat still has a session, nothing is cached.
    h.sessions.set('chat-1', 'sess-1', h.cwd);

    await expect(h.run('/skills')).resolves.toBe(true);
    const card = JSON.stringify(h.lastCard());
    expect(card).toContain('/probed');
    // The probe can't see what that session loaded from subdirectories.
    expect(card).toContain('没列全');
    expect(cachedSkillCatalog(h.agent.id, h.cwd, 'sess-1')).toBeUndefined();
    expect(cachedSkillCatalog(h.agent.id, h.cwd, undefined)?.skills[0]?.name).toBe('probed');

    // The session's next run reports its exact list, which then wins.
    rememberSkillCatalog(h.agent.id, h.cwd, 'sess-1', {
      names: ['apps/web:deploy', 'probed'],
      plugins: [],
    });
    await expect(h.run('/skills')).resolves.toBe(true);
    const refreshed = JSON.stringify(h.lastCard());
    expect(refreshed).toContain('apps/web:deploy');
    expect(refreshed).not.toContain('没列全');
    expect(h.agent.listSkillsCalls).toHaveLength(1);
  });

  it('re-probes a session-less chat once its cached list goes stale', async () => {
    const h = await createHarness({ skills: { names: ['old-skill'], plugins: [] } });
    await expect(h.run('/skills')).resolves.toBe(true);
    expect(JSON.stringify(h.lastCard())).toContain('/old-skill');

    // The user swaps skills; no run refreshes the fresh-session entry.
    h.agent.setSkillSource({ names: ['new-skill'], plugins: [] });
    await expect(h.run('/skills')).resolves.toBe(true);
    expect(JSON.stringify(h.lastCard())).toContain('/old-skill');
    expect(h.agent.listSkillsCalls).toHaveLength(1);

    const later = Date.now() + FRESH_CATALOG_TTL_MS;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      await expect(h.run('/skills')).resolves.toBe(true);
    } finally {
      clock.mockRestore();
    }
    const card = JSON.stringify(h.lastCard());
    expect(card).toContain('/new-skill');
    expect(card).not.toContain('/old-skill');
    expect(h.agent.listSkillsCalls).toHaveLength(2);
  });

  it('says the lookup failed rather than showing an empty list', async () => {
    const h = await createHarness({
      skills: async () => {
        throw new Error('claude skill probe timed out after 30000ms');
      },
    });

    await expect(h.run('/skills')).resolves.toBe(true);
    const card = JSON.stringify(h.lastCard());
    expect(card).toContain('取不到技能列表');
    expect(card).toContain('timed out');
  });

  it('treats an empty list as a broken lookup, not as "no skills"', async () => {
    const h = await createHarness({ skills: { names: [], plugins: [] } });

    await expect(h.run('/skills')).resolves.toBe(true);
    const card = JSON.stringify(h.lastCard());
    expect(card).toContain('取不到技能列表');
    expect(card).toContain('空清单');
  });

  it('says an agent without skills has none, distinct from a failure', async () => {
    // No `skills` option => the adapter has no listSkills method, which is
    // how Codex looks to this command.
    const h = await createHarness({ displayName: 'Codex' });

    await expect(h.run('/skills')).resolves.toBe(true);
    const card = JSON.stringify(h.lastCard());
    expect(card).toContain('Codex');
    expect(card).toContain('没有 skills 机制');
    expect(card).not.toContain('取不到');
  });
});

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  cwd: string;
  run(content: string): Promise<boolean>;
  lastCard(): unknown;
}

async function writeProjectSkill(cwd: string, name: string, description: string): Promise<void> {
  const dir = join(cwd, '.claude', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`,
    'utf8',
  );
}

async function createHarness(
  opts: { skills?: FakeSkillSource; displayName?: string } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile('skills-command-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter({
    id: 'claude',
    displayName: opts.displayName ?? 'Claude Code',
    ...(opts.skills ? { skills: opts.skills } : {}),
  });
  const cwd = await realpath(tmp.workspace);
  // Skill resolution reads the home directory, and a personal skill beats a
  // project one. Without an empty home, a developer who has `handoff` in
  // their own `~/.claude/skills` sees that description instead of the
  // fixture's and the test fails on their machine only.
  const home = join(tmp.root, 'home');
  await mkdir(home, { recursive: true });
  const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const profileConfig = appConfig(cwd);
  const configPath = join(tmp.root, 'config.json');
  await saveRootConfig(createRootConfig('claude', profileConfig), configPath);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  workspaces.setCwd('chat-1', cwd);

  cleanups.push(async () => {
    for (const [key, value] of Object.entries(savedHome)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    agent,
    sessions,
    cwd,
    lastCard: () => (channel.sent.at(-1)?.content as { card?: unknown } | undefined)?.card,
    run: (content: string) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: message(content),
        scope: 'chat-1',
        chatMode: 'p2p',
        sessions,
        workspaces,
        agent,
        activeRuns,
        controls,
      }),
  };
}

function appConfig(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(content: string): NormalizedMessage {
  return {
    messageId: 'om-1',
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}
