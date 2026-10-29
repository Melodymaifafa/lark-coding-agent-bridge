import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { log } from '../../../src/core/logger.js';
import {
  fetchKnownChats,
  KNOWN_CHATS_REFRESH_INTERVAL_MS,
  resetKnownChatsDenialForTest,
  startKnownChatsRefreshTimer,
  type KnownChat,
} from '../../../src/bot/lark-info.js';

const THREE_HOURS = 3 * 60 * 60 * 1000;

/** What node-sdk throws when im.v1.chat.list is denied, in the real bridge log's shape. */
function chatListDenied(): Error {
  return Object.assign(new Error('Request failed with status code 400'), {
    config: { method: 'get', url: 'https://open.feishu.cn/open-apis/im/v1/chats' },
    response: {
      status: 400,
      statusText: 'Bad Request',
      data: {
        code: 99991672,
        msg: 'Access denied. One of the following scopes is required: [im:chat:readonly, im:chat, im:chat:read].',
        error: {
          permission_violations: [
            { type: 'action_scope_required', subject: 'im:chat:readonly' },
            { type: 'action_scope_required', subject: 'im:chat' },
            { type: 'action_scope_required', subject: 'im:chat:read' },
          ],
        },
      },
    },
  });
}

function timeoutError(): Error {
  return Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });
}

function fakeChannel(listChats: () => Promise<Array<{ id: string; name: string }>>) {
  const fn = vi.fn(listChats);
  return { channel: { listChats: fn } as unknown as LarkChannel, listChats: fn };
}

function chatFailures(warn: ReturnType<typeof vi.spyOn>): unknown[][] {
  return warn.mock.calls.filter((c: unknown[]) => c[0] === 'lark-info' && c[1] === 'chats-fetch-failed');
}

describe('known chats refresh when the app lacks the chat-read scope', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    resetKnownChatsDenialForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('logs one line naming the scope and stops the 30-minute refresh', async () => {
    const { channel, listChats } = fakeChannel(async () => {
      throw chatListDenied();
    });
    const refresh = startKnownChatsRefreshTimer(channel, {});

    await vi.advanceTimersByTimeAsync(THREE_HOURS);

    expect(listChats).toHaveBeenCalledTimes(1);
    expect(chatFailures(warn)).toEqual([
      [
        'lark-info',
        'chats-fetch-failed',
        {
          err: 'Request failed with status code 400',
          missingScopes: 'im:chat:readonly, im:chat, im:chat:read',
          retry: 'off until restart',
        },
      ],
    ]);
    expect(vi.getTimerCount()).toBe(0);
    refresh.stop();
  });

  it('keeps retrying every 30 minutes on a timeout', async () => {
    const { channel, listChats } = fakeChannel(async () => {
      throw timeoutError();
    });
    const refresh = startKnownChatsRefreshTimer(channel, {});

    await vi.advanceTimersByTimeAsync(THREE_HOURS);

    expect(listChats).toHaveBeenCalledTimes(1 + THREE_HOURS / KNOWN_CHATS_REFRESH_INTERVAL_MS);
    expect(chatFailures(warn)).toHaveLength(listChats.mock.calls.length);
    expect(chatFailures(warn)[0]).toEqual([
      'lark-info',
      'chats-fetch-failed',
      { err: 'timeout of 30000ms exceeded' },
    ]);
    expect(vi.getTimerCount()).toBe(1);
    refresh.stop();
  });

  it('leaves callers the last known chats and an empty list without asking Feishu again', async () => {
    const known: KnownChat[] = [{ id: 'oc_1', name: 'team' }];
    const controls = { knownChats: known };
    const { channel, listChats } = fakeChannel(async () => {
      throw chatListDenied();
    });
    startKnownChatsRefreshTimer(channel, controls);
    await vi.advanceTimersByTimeAsync(THREE_HOURS);

    // /config and /invite all group fetch on demand.
    await expect(fetchKnownChats(channel)).resolves.toEqual([]);

    expect(listChats).toHaveBeenCalledTimes(1);
    expect(chatFailures(warn)).toHaveLength(1);
    expect(controls.knownChats).toBe(known);
  });

  it('tries again once after a restart, so granting the scope recovers', async () => {
    const denied = fakeChannel(async () => {
      throw chatListDenied();
    });
    await fetchKnownChats(denied.channel);

    resetKnownChatsDenialForTest(); // a new process starts with no memory
    const granted = fakeChannel(async () => [{ id: 'oc_1', name: 'team' }]);
    const controls: { knownChats?: KnownChat[] } = {};
    const refresh = startKnownChatsRefreshTimer(granted.channel, controls);
    await vi.advanceTimersByTimeAsync(0);

    expect(granted.listChats).toHaveBeenCalledTimes(1);
    expect(controls.knownChats).toEqual([{ id: 'oc_1', name: 'team' }]);
    expect(vi.getTimerCount()).toBe(1);
    refresh.stop();
  });
});
