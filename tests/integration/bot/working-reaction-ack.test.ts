import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, AgentRunOptions } from '../../../src/agent/types.js';
import type { MessageReplyMode } from '../../../src/config/schema.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

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

const ACK_TEXT = '收到，正在处理…';
const ANSWER = '能改。更准确地说…';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface SentMessage {
  chatId: string;
  content: { text?: string; markdown?: string; card?: unknown };
  options?: unknown;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: SentMessage[];
  addReaction: ReturnType<typeof vi.fn>;
  removeReaction: ReturnType<typeof vi.fn>;
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: { v6: { application: { get: ReturnType<typeof vi.fn> } } };
    im: { v1: { message: { get: ReturnType<typeof vi.fn> } } };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: SentMessage['content'], options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

/** Holds the agent's events back until `gate` resolves, so a test can look at a run in progress. */
class GatedAgentAdapter extends FakeAgentAdapter {
  readonly #gate: Promise<void>;

  constructor(gate: Promise<void>) {
    super({
      id: 'codex',
      displayName: 'Codex',
      events: [
        [
          { type: 'text', delta: ANSWER },
          { type: 'done', terminationReason: 'normal' },
        ],
      ],
    });
    this.#gate = gate;
  }

  override run(opts: AgentRunOptions): AgentRun {
    const inner = super.run(opts);
    const gate = this.#gate;
    return {
      runId: inner.runId,
      events: (async function* () {
        await gate;
        yield* inner.events;
      })(),
      stop: () => inner.stop(),
      waitForExit: (timeoutMs) => inner.waitForExit(timeoutMs),
    };
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('text ack when the working reaction cannot be added', () => {
  it.each(['text', 'markdown'] as const)(
    'sends the ack during the run and the final reply after it in %s mode',
    async (reply) => {
      const gate = deferred<void>();
      const h = await startBridge({ reply, gate: gate.promise, addReaction: reject400 });

      await h.channel.handlers.message?.(dmMessage('om_first'));
      await waitFor(() => acks(h.channel).length === 1, 3000);

      expect(replies(h.channel)).toEqual([]);
      expect(acks(h.channel)[0]).toEqual({
        chatId: 'oc_dm',
        content: { text: ACK_TEXT },
        options: { replyTo: 'om_first' },
      });

      gate.resolve();
      await waitFor(() => replies(h.channel).length === 1);

      expect(replies(h.channel)[0]?.content.markdown).toContain(ANSWER);
      expect(acks(h.channel)).toHaveLength(1);
    },
  );

  it('keeps the ack inside the topic in a topic group', async () => {
    const h = await startBridge({ reply: 'text', chatMode: 'topic', addReaction: reject400 });

    await h.channel.handlers.message?.(topicMessage('om_topic_msg'));
    await waitFor(() => acks(h.channel).length === 1, 3000);

    expect(acks(h.channel)[0]?.options).toEqual({ replyTo: 'om_topic_msg', replyInThread: true });
  });

  it('does not send the ack when the reaction is added', async () => {
    const h = await startBridge({ reply: 'text', addReaction: async () => 'reaction_1' });

    await h.channel.handlers.message?.(dmMessage('om_first'));
    await waitFor(() => replies(h.channel).length === 1);
    await waitFor(() => h.channel.removeReaction.mock.calls.length === 1);

    expect(h.channel.addReaction).toHaveBeenCalledWith('om_first', 'Typing');
    expect(h.channel.removeReaction).toHaveBeenCalledWith('om_first', 'reaction_1');
    expect(acks(h.channel)).toEqual([]);
  });

  it('still sends the final reply when the ack cannot be sent', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const h = await startBridge({
      reply: 'text',
      addReaction: reject400,
      send: async (content) => {
        if (content.text === ACK_TEXT) throw new Error('ack send failed');
      },
    });

    await h.channel.handlers.message?.(dmMessage('om_first'));
    await waitFor(() => replies(h.channel).length === 1);
    await waitFor(() => warn.mock.calls.some((call) => call[1] === 'ack-send-failed'));

    expect(replies(h.channel)[0]?.content.markdown).toContain(ANSWER);
    expect(warn).toHaveBeenCalledWith('reaction', 'ack-send-failed', {
      messageId: 'om_first',
      err: 'ack send failed',
    });
  });

  it('does not send the ack when the reaction fails after the run ended', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const reaction = deferred<string>();
    const h = await startBridge({ reply: 'text', addReaction: () => reaction.promise });

    await h.channel.handlers.message?.(dmMessage('om_first'));
    await waitFor(() => replies(h.channel).length === 1);

    reaction.reject(new Error('Request failed with status code 400'));
    await waitFor(() => warn.mock.calls.some((call) => call[1] === 'add-failed'));

    expect(acks(h.channel)).toEqual([]);
  });

  it('adds no reaction and sends no ack in card mode', async () => {
    const h = await startBridge({ reply: 'card', addReaction: reject400 });

    await h.channel.handlers.message?.(dmMessage('om_first'));
    await waitFor(() => h.channel.sent.some((sent) => sent.content.card !== undefined));

    expect(h.channel.addReaction).not.toHaveBeenCalled();
    expect(acks(h.channel)).toEqual([]);
  });
});

async function reject400(): Promise<string> {
  throw new Error('Request failed with status code 400');
}

async function startBridge(options: {
  reply: MessageReplyMode;
  addReaction: () => Promise<string>;
  gate?: Promise<void>;
  chatMode?: 'group' | 'topic';
  send?: (content: SentMessage['content']) => Promise<void>;
}): Promise<{ channel: FakeLarkChannel }> {
  const tmp = await createTmpProfile('working-reaction-ack-');
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
      allowedChats: ['oc_topic_chat'],
      allowedUsers: ['ou_user'],
    },
    codex: {
      binaryPath: '/usr/local/bin/codex',
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    preferences: {
      ...baseProfileConfig.preferences,
      messageReply: options.reply,
      messageReplyMigrated: true,
    },
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  const bridge = await startChannel({
    cfg: profileConfig,
    agent: new GatedAgentAdapter(options.gate ?? Promise.resolve()),
    sessions,
    workspaces,
    controls: {
      profile: 'codex',
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
  cleanups.push(() => bridge.disconnect());
  return { channel };
}

function createFakeLarkChannel(options: {
  addReaction: () => Promise<string>;
  chatMode?: 'group' | 'topic';
  send?: (content: SentMessage['content']) => Promise<void>;
}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: SentMessage[] = [];
  return {
    handlers,
    sent,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    addReaction: vi.fn(options.addReaction),
    removeReaction: vi.fn(async () => {}),
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
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return options.chatMode ?? 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, sendOptions) {
      await options.send?.(content);
      sent.push({ chatId, content, options: sendOptions });
    },
    // Never starts the producer: a markdown or card run ends in the fallback `send`.
    async stream() {
      await new Promise<void>(() => {});
    },
  };
}

function acks(channel: FakeLarkChannel): SentMessage[] {
  return channel.sent.filter((sent) => sent.content.text === ACK_TEXT);
}

function replies(channel: FakeLarkChannel): SentMessage[] {
  return channel.sent.filter((sent) => sent.content.markdown !== undefined);
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

function dmMessage(messageId: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content: '默认值能改吗',
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function topicMessage(messageId: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_topic_chat',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content: '@Bridge 默认值能改吗',
    rawContentType: 'text',
    resources: [],
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }],
    mentionAll: false,
    mentionedBot: true,
    rootId: 'om_topic_root',
    parentId: 'om_topic_root',
    threadId: 'omt_topic',
    replyToMessageId: 'om_topic_root',
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
