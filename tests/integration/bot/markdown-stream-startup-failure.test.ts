import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexJsonlTranslator } from '../../../src/agent/codex/jsonl.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
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

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

type StreamFn = FakeLarkChannel['stream'];

// What Codex said on 2026-10-02 (session 01a0a8c9), shortened the same way as
// the 2026-11-07 check-up evidence: two progress lines, then the answer.
const PROGRESS_ONE = '我先看一下今天的题目卡和点击记录，确认你问的“默认值”具体指哪一个。';
const PROGRESS_TWO =
  '你已经点过「看答案」了，所以我直接说结论；我再核对一下现在 GitHub Action 的准确配置写法。';
const ANSWER = '能改。更准确地说，是在 GitHub workflow 里显式覆盖默认模型。';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('markdown stream startup failures', () => {
  it('does not leave the IM queue blocked when the agent exits before stream producer starts', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_first', reaction_id: 'reaction_1' },
      }),
    );
    expect(lastMarkdown(h.channel)).toContain('agent 失败');
    expect(lastMarkdown(h.channel)).toContain('codex exited with code 1');
  });

  it('does not wait for the working reaction before draining a failed agent run', async () => {
    const reaction = deferred<{ data: { reaction_id: string } }>();
    const h = await createHarness({
      reactionCreate: () => reaction.promise,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2, 1000);

    expect(lastMarkdown(h.channel)).toContain('agent 失败');

    reaction.resolve({ data: { reaction_id: 'reaction_1' } });
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);
  });

  it('logs stream failures that arrive after terminal grace expires', async () => {
    const streamFailure = deferred<void>();
    let streamProducerStarted = false;
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (producer) {
          streamProducerStarted = true;
          void producer({ setContent: vi.fn(async () => {}) });
        }
        await streamFailure.promise;
      },
    });
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => streamProducerStarted);
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      4500,
    );

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    streamFailure.reject(new Error('late stream failed'));

    await waitFor(() =>
      fail.mock.calls.some((call) =>
        call[0] === 'stream' &&
        call[1] instanceof Error &&
        call[1].message === 'late stream failed' &&
        (call[2] as { step?: string } | undefined)?.step === 'stream-terminal-late',
      ),
    );
  }, 10_000);
});

describe('Codex final reply', () => {
  it.each([
    {
      name: 'messages only',
      raw: [agentMessage(PROGRESS_ONE), agentMessage(PROGRESS_TWO), agentMessage(ANSWER)],
    },
    {
      name: 'a command between messages, as in the real session',
      raw: [
        agentMessage(PROGRESS_ONE),
        ...command('cmd-1'),
        agentMessage(PROGRESS_TWO),
        ...command('cmd-2'),
        agentMessage(ANSWER),
      ],
    },
  ])('sends only the answer in text mode: $name', async ({ raw }) => {
    const h = await createHarness({
      events: codexEvents([{ type: 'thread.started', thread_id: 't-1' }, ...raw]),
      preferences: { messageReply: 'text', showToolCalls: false },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_answer', '默认值能改吗'));
    await waitFor(() => h.channel.sent.length === 1);
    await settle();

    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toBe(ANSWER);
  });

  it('sends the only message when Codex said one thing in text mode', async () => {
    const h = await createHarness({
      events: codexEvents([agentMessage(ANSWER)]),
      preferences: { messageReply: 'text' },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_one', 'run'));
    await waitFor(() => h.channel.sent.length === 1);
    await settle();

    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toBe(ANSWER);
  });

  it('sends no empty message when Codex said nothing in text mode', async () => {
    const h = await createHarness({
      events: codexEvents([]),
      preferences: { messageReply: 'text' },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_silent', 'run'));
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);

    expect(h.channel.sent).toEqual([]);
  });

  it('keeps tool lines but drops progress lines when tool calls are shown in text mode', async () => {
    const h = await createHarness({
      events: codexEvents([agentMessage(PROGRESS_ONE), ...command('cmd-1'), agentMessage(ANSWER)]),
      preferences: { messageReply: 'text', showToolCalls: true },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_tools', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    const reply = lastMarkdown(h.channel);
    expect(reply).toContain('> ');
    expect(reply).toContain(ANSWER);
    expect(reply).not.toContain(PROGRESS_ONE);
  });

  it('keeps what Codex said when the turn fails in text mode', async () => {
    const h = await createHarness({
      events: codexEvents([
        agentMessage(PROGRESS_ONE),
        { type: 'turn.failed', error: { message: 'model stopped' } },
      ]),
      preferences: { messageReply: 'text' },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_failed', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(lastMarkdown(h.channel)).toContain(PROGRESS_ONE);
    expect(lastMarkdown(h.channel)).toContain('model stopped');
  });

  it('keeps every text event in text mode when the agent names no final answer', async () => {
    // Claude's event shape: it never sends `final_text`.
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'first ' },
        { type: 'text', delta: 'second' },
        { type: 'done', terminationReason: 'normal' },
      ],
      preferences: { messageReply: 'text' },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_claude', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(lastMarkdown(h.channel)).toBe('first second');
  });

  it('shows the answer in the one streaming card in card mode', async () => {
    const cards: unknown[] = [];
    const h = await createHarness({
      events: codexEvents([agentMessage(PROGRESS_ONE), agentMessage(ANSWER)]),
      preferences: { messageReply: 'card' },
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        await producer?.({
          update: vi.fn(async (next: unknown) => {
            cards.push(next);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card', 'run'));
    await waitFor(() => JSON.stringify(cards.at(-1) ?? '').includes(ANSWER));
    await settle();

    expect(JSON.stringify(cards.at(-1))).toContain(PROGRESS_ONE);
    expect(h.channel.sent).toEqual([]);
  });

  it('shows the answer in the one streaming message in markdown mode', async () => {
    const contents: string[] = [];
    const h = await createHarness({
      events: codexEvents([agentMessage(PROGRESS_ONE), agentMessage(ANSWER)]),
      preferences: { messageReply: 'markdown' },
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            contents.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_markdown', 'run'));
    await waitFor(() => (contents.at(-1) ?? '').includes(ANSWER));
    await settle();

    expect(contents.at(-1)).toBe(`${PROGRESS_ONE}\n\n${ANSWER}`);
    expect(h.channel.sent).toEqual([]);
  });

  it('still delivers the answer when the markdown stream fails to start', async () => {
    vi.spyOn(log, 'fail').mockImplementation(() => {});
    const h = await createHarness({
      events: codexEvents([agentMessage(ANSWER)]),
      preferences: { messageReply: 'markdown' },
      stream: async () => {
        throw new Error('stream failed');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stream_fail', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(lastMarkdown(h.channel)).toBe(ANSWER);
  });
});

function agentMessage(text: string): Record<string, unknown> {
  return { type: 'item.completed', item: { id: `msg-${text}`, type: 'agent_message', text } };
}

function command(id: string): Array<Record<string, unknown>> {
  return [
    { type: 'item.started', item: { id, type: 'command_execution', command: 'pwd' } },
    {
      type: 'item.completed',
      item: { id, type: 'command_execution', output: '/repo\n', exit_code: 0 },
    },
  ];
}

/** Translates raw Codex lines the way the adapter does, ending the turn unless a line already did. */
function codexEvents(raw: ReadonlyArray<Record<string, unknown>>): AgentEvent[] {
  const translator = new CodexJsonlTranslator();
  const events = raw.flatMap((line) => translator.translate(line));
  return translator.terminalEmitted()
    ? events
    : [...events, ...translator.translate({ type: 'turn.completed' })];
}

/** Gives a duplicate reply time to fire before a test asserts there is none. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

async function createHarness(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  events?: readonly AgentEvent[];
  preferences?: { messageReply?: 'card' | 'markdown' | 'text'; showToolCalls?: boolean };
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('markdown-stream-startup-failure-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedUsers: ['ou_user'],
    },
    codex: {
      binaryPath: '/usr/local/bin/codex',
    },
    ...(options.preferences
      ? { preferences: { ...options.preferences, messageReplyMigrated: true } }
      : {}),
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'codex',
    displayName: 'Codex',
    events: options.events
      ? [options.events]
      : [
          [
            {
              type: 'error',
              message: 'codex exited with code 1: Error loading config.toml',
              terminationReason: 'failed',
            },
          ],
          [{ type: 'done', terminationReason: 'normal' }],
        ],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
} = {}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(options.reactionCreate ?? (async () => ({ data: { reaction_id: 'reaction_1' } }))),
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
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
    },
    stream: options.stream ?? (async () => {
      await new Promise<void>(() => {});
    }),
    async addReaction(messageId, emojiType) {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return (r as { data?: { reaction_id?: string } })?.data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'codex',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeLarkChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown ?? '';
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
