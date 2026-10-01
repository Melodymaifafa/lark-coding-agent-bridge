import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import {
  RECALL_ANSWER,
  RECALL_ASKED,
  RECALL_QUESTION,
  RECALL_SWAP_ID,
  recallAnswerCard,
  recallQuestionCard,
} from '../../helpers/knowledge-recall-card.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

/**
 * MEL-274 — the whole hop, from a reply-quote event to the prompt the agent
 * actually receives.
 *
 * `tests/unit/bot/quote-card.test.ts` pins the SDK flattening in
 * `fetchQuotedContext`. That alone is not enough: nothing guarantees the
 * flattened card text survives into the prompt. So this test drives the real
 * intake handler (`startChannel`) with a reply-quote event and reads the prompt
 * off the agent adapter — the same string the live Codex process is given.
 * Break anything between the fetch and the prompt (quote collection, the
 * `toPromptQuote` mapping, the `quoted_messages` section) and this goes red.
 */

const QUOTED_CARD_ID = 'om_recall_card';

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
  rawClient: unknown;
  getAppInfo: ReturnType<typeof vi.fn>;
  listChats: ReturnType<typeof vi.fn>;
  fetchRawMessage: ReturnType<typeof vi.fn>;
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
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

describe('replying to a knowledge-recall card', () => {
  it('puts the card text in the prompt the agent is actually handed', async () => {
    const prompt = await promptForReplyTo(recallQuestionCard(), '那为什么不能直接当文件夹用？');

    // The section buildAgentPrompt emits for quotes, and the id of the card she
    // replied to — so the agent can tell which message the text came from.
    expect(prompt).toContain('<quoted_messages>');
    expect(prompt).toContain(QUOTED_CARD_ID);
    expect(prompt).toContain('interactive');
    expect(prompt).not.toContain('[interactive card]');

    // The line AGENTS.md tells the agent to match against cards/*.json. If this
    // does not survive into the prompt, the agent cannot find the card at all.
    expect(prompt).toContain(RECALL_QUESTION);
    expect(prompt).toContain(RECALL_ASKED);

    // And her own follow-up still reaches it, after the quote.
    expect(prompt).toContain('那为什么不能直接当文件夹用？');
    expect(prompt.indexOf(RECALL_QUESTION)).toBeLessThan(
      prompt.indexOf('那为什么不能直接当文件夹用？'),
    );
  });

  it('carries the revealed answer when she replies to the opened card', async () => {
    const prompt = await promptForReplyTo(recallAnswerCard(), '那 main 也是分支吗？');

    expect(prompt).toContain(RECALL_QUESTION);
    expect(prompt).toContain(RECALL_ANSWER);
  });

  it('still does not carry the card id, so matching on the question is required', async () => {
    const prompt = await promptForReplyTo(recallQuestionCard(), '为什么不能直接用？');

    // Mirrors the unit test one layer up: the id lives in the button `value`
    // and the SDK drops it. Flip both the day it is surfaced on purpose.
    expect(prompt).not.toContain(RECALL_SWAP_ID);
  });
});

/**
 * Feed `startChannel` a reply-quote of `cardContent` plus `followUp`, and
 * return the prompt the agent adapter was invoked with.
 */
async function promptForReplyTo(cardContent: string, followUp: string): Promise<string> {
  const h = await createHarness(cardContent);
  await startTestBridge(h);

  await h.channel.handlers.message?.(replyToCard(followUp));
  await waitFor(() => h.agent.runOptions.length === 1);

  expect(h.channel.fetchRawMessage).toHaveBeenCalledWith(
    QUOTED_CARD_ID,
    expect.objectContaining({ cardContentType: 'user_card_content' }),
  );
  return h.agent.runOptions[0]?.prompt ?? '';
}

async function createHarness(cardContent: string): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('quote-recall-card-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    // The live bot is the Codex one; prompt assembly is agent-agnostic, but
    // keep the kind honest so a future agent-specific prompt branch is covered.
    agentKind: 'codex',
    // Never spawned — FakeAgentAdapter stands in for the Codex process.
    codex: { binaryPath: '/usr/bin/true' },
    accounts: {
      app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' },
    },
    access: {
      allowedChats: ['oc_recall_chat'],
      allowedUsers: ['ou_melody'],
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: { ...baseProfileConfig.workspaces, default: workspace },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const channel = createFakeLarkChannel(cardContent);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { tmp, channel, agent, sessions, workspaces, profileConfig, controls };
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

function createFakeLarkChannel(
  cardContent: string,
): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  return {
    handlers,
    botIdentity: { openId: 'ou_bot', name: "Melody's Codex Agent" },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: {
        v1: {
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    getAppInfo: vi.fn(async () => ({ ownerId: 'ou_melody' })),
    listChats: vi.fn(async () => []),
    // The pushed recall card, as `im.v1.message.get` returns it.
    fetchRawMessage: vi.fn(async (messageId: string) => [
      {
        message_id: messageId,
        msg_type: 'interactive',
        body: { content: cardContent },
        create_time: '1790000000000',
        sender: { id: 'ou_bot' },
      },
    ]),
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

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test',
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

/** Her follow-up, sent as a Feishu reply to the pushed card. */
function replyToCard(content: string): NormalizedMessage {
  return {
    messageId: 'om_followup',
    chatId: 'oc_recall_chat',
    chatType: 'group',
    senderId: 'ou_melody',
    senderName: 'Melody',
    content: `@Agent ${content}`,
    rawContentType: 'text',
    resources: [],
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Agent', isBot: true }],
    mentionAll: false,
    mentionedBot: true,
    rootId: QUOTED_CARD_ID,
    parentId: QUOTED_CARD_ID,
    replyToMessageId: QUOTED_CARD_ID,
    createTime: 1790000001000,
  } as unknown as NormalizedMessage;
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
