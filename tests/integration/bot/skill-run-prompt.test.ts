import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface HandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
  cardAction?: (evt: CardActionEvent) => Promise<void> | void;
}

interface FakeLarkChannel {
  handlers: HandlerMap;
  botIdentity: { openId: string; name: string };
  rawClient: unknown;
  on(handlers: HandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * Claude Code only treats `/<skill>` as an invocation at the very start of
 * its prompt, so a `/skills` run click must reach the agent bare — not
 * wrapped in `<bridge_context>` / `<user_input>` like ordinary chat.
 */
describe('/skills run click → agent prompt', () => {
  it('sends the skill to the agent as the bare slash prompt', async () => {
    const h = await startHarness();

    await h.click('handoff');
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions[0]?.prompt).toBe('/handoff');
  });

  it('runs a click on its own turn, after messages queued ahead of it', async () => {
    const h = await startHarness();

    await h.channel.handlers.message?.(message('om_text', '@Bridge 先看下这个'));
    await h.click('handoff');
    await waitFor(() => h.agent.runOptions.length === 2);

    const [first, second] = h.agent.runOptions;
    expect(first?.prompt).toContain('<user_input>');
    expect(first?.prompt).toContain('先看下这个');
    expect(first?.prompt).not.toContain('/handoff');
    expect(second?.prompt).toBe('/handoff');
  });
});

async function startHarness(): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  click(skill: string): Promise<void>;
}> {
  const tmp = await createTmpProfile('skill-run-prompt-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedChats: ['oc_chat'], allowedUsers: ['ou_user'] },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: { ...baseProfileConfig.workspaces, default: workspace },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const done: AgentEvent[] = [{ type: 'done', terminationReason: 'normal' }];
  const agent = new FakeAgentAdapter({ events: [done, done] });
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;

  const bridge = await startChannel({
    cfg: profileConfig,
    agent,
    sessions,
    workspaces,
    controls: {
      profile: 'test',
      profileConfig,
      ownerRefreshState: 'unknown' as const,
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: '/tmp/config.json',
      cfg: profileConfig,
      processId: 'proc_test',
    },
  });
  cleanups.push(async () => {
    await bridge.disconnect();
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    agent,
    click: async (skill: string) => {
      await channel.handlers.cardAction?.({
        chatId: 'oc_chat',
        messageId: 'om_skills_card',
        operator: { openId: 'ou_user', name: 'User' },
        action: { value: { cmd: 'skills.run', arg: skill, cwd: workspace } },
      } as unknown as CardActionEvent);
    },
  };
}

function createFakeLarkChannel(): FakeLarkChannel {
  const handlers: HandlerMap = {};
  return {
    handlers,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({ data: { app: { owner: { owner_id: 'ou_owner' } } } })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send() {},
    async stream(_chatId, input) {
      if (isMarkdownStreamInput(input)) {
        await input.markdown({ setContent: async () => {} });
      }
    },
  };
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}
