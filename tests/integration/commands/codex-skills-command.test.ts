import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { CodexAdapter } from '../../../src/agent/codex/adapter.js';
import type { AgentAdapter } from '../../../src/agent/types.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { clearSkillCatalogs } from '../../../src/skills/registry.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

/**
 * Codex reports no skill list, so its adapter reads `~/.codex/skills` from
 * disk. These run the real adapter against a temp HOME.
 */
describe('/skills under Codex', () => {
  beforeEach(() => clearSkillCatalogs());

  afterEach(async () => {
    clearSkillCatalogs();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('lists the Codex skills in ~/.codex/skills, labelled and invoked with $', async () => {
    const h = await createHarness();
    await writeCodexSkill(h.home, 'handoff', '写一份 session 交接记录。');
    await writeCodexSkill(h.home, 'diagnose', '一步步定位难查的 bug。');

    await expect(h.run('/skills')).resolves.toBe(true);
    const card = JSON.stringify(h.lastCard());

    expect(card).toContain('当前有 **2** 个技能');
    expect(card).toContain('$handoff');
    expect(card).toContain('写一份 session 交接记录。');
    expect(card).toContain('$diagnose');
    expect(card).toContain('一步步定位难查的 bug。');
    expect(card).toContain('_(Codex)_');
    expect(card).toContain('▸ 运行 $handoff');
    expect(card).toContain('"arg":"handoff"');
    // `/handoff` does nothing in Codex, so no button may offer it.
    expect(card).not.toContain('运行 /');
  });

  it('says there are no skills, naming where it looked, when none are installed', async () => {
    const h = await createHarness();

    await expect(h.run('/skills')).resolves.toBe(true);
    const card = JSON.stringify(h.lastCard());

    expect(card).toContain('当前没有可用技能');
    expect(card).toContain(JSON.stringify(join(h.home, '.codex', 'skills')).slice(1, -1));
    expect(card).not.toContain('取不到');
    expect(card).not.toContain('空清单');
  });

  it('still says a Codex agent without a skill lookup has no skills', async () => {
    const h = await createHarness({
      agent: new FakeAgentAdapter({ id: 'codex', displayName: 'Codex CLI' }),
    });

    await expect(h.run('/skills')).resolves.toBe(true);
    const card = JSON.stringify(h.lastCard());
    expect(card).toContain('没有 skills 机制');
    expect(card).not.toContain('当前没有可用技能');
  });
});

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  home: string;
  run(content: string): Promise<boolean>;
  lastCard(): unknown;
}

async function writeCodexSkill(home: string, name: string, description: string): Promise<void> {
  const dir = join(home, '.codex', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`,
    'utf8',
  );
}

async function createHarness(opts: { agent?: AgentAdapter } = {}): Promise<Harness> {
  const tmp = await createTmpProfile('codex-skills-command-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent =
    opts.agent ?? new CodexAdapter({ binary: 'codex', profileStateDir: join(tmp.profile, 'state') });
  const cwd = await realpath(tmp.workspace);
  // Never read the developer's real `~/.codex` or `~/.agents`.
  const home = join(tmp.root, 'home');
  await mkdir(home, { recursive: true });
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CODEX_HOME;
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    codex: { binaryPath: 'codex' },
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
  });
  profileConfig.workspaces.default = cwd;
  const controls = {
    profile: 'codex',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.root, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  workspaces.setCwd('chat-1', cwd);

  cleanups.push(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    home,
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
