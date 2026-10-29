import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { getMissingScopes, resetMissingScopesForTest } from '../../../src/bot/lark-permission.js';
import { log } from '../../../src/core/logger.js';

function deniedError(scopes: string[]): Error {
  return Object.assign(new Error('Request failed with status code 400'), {
    response: {
      status: 400,
      data: {
        code: 99991672,
        msg: `Access denied. One of the following scopes is required: [${scopes.join(', ')}].`,
        error: {
          permission_violations: scopes.map((subject) => ({ type: 'action_scope_required', subject })),
        },
      },
    },
  });
}

function fakeChannel(getChatMode: (chatId: string) => Promise<'p2p' | 'group' | 'topic'>) {
  const fn = vi.fn(getChatMode);
  return { channel: { getChatMode: fn } as unknown as LarkChannel, getChatMode: fn };
}

describe('ChatModeCache', () => {
  afterEach(() => {
    resetMissingScopesForTest();
    vi.restoreAllMocks();
  });

  it('caches a successful lookup', async () => {
    vi.spyOn(log, 'info').mockImplementation(() => {});
    const { channel, getChatMode } = fakeChannel(async () => 'topic');
    const cache = new ChatModeCache();

    await expect(cache.resolve(channel, 'oc_1', 'group')).resolves.toBe('topic');
    await expect(cache.resolve(channel, 'oc_1', 'group')).resolves.toBe('topic');

    expect(getChatMode).toHaveBeenCalledTimes(1);
  });

  it("falls back to the message's own p2p type when the lookup fails", async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { channel } = fakeChannel(async () => {
      throw deniedError(['im:chat:readonly', 'im:chat', 'im:chat:read']);
    });

    await expect(new ChatModeCache().resolve(channel, 'oc_dm', 'p2p')).resolves.toBe('p2p');
  });

  it('falls back to group without a hint and does not cache the failure', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
    const { channel, getChatMode } = fakeChannel(async () => {
      throw new Error('timeout of 30000ms exceeded');
    });
    const cache = new ChatModeCache();

    await expect(cache.resolve(channel, 'oc_1')).resolves.toBe('group');

    getChatMode.mockResolvedValueOnce('p2p');
    await expect(cache.resolve(channel, 'oc_1')).resolves.toBe('p2p');
    expect(getChatMode).toHaveBeenCalledTimes(2);
  });

  it('keeps the per-failure warning for errors that are not about permissions', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { channel } = fakeChannel(async () => {
      throw new Error('getaddrinfo ENOTFOUND open.feishu.cn');
    });
    const cache = new ChatModeCache();

    await cache.resolve(channel, 'oc_1');
    await cache.resolve(channel, 'oc_1');

    expect(warn.mock.calls.filter((c) => c[1] === 'mode-resolve-failed')).toHaveLength(2);
  });

  it('logs a missing scope once across repeated failures, naming the scope', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { channel } = fakeChannel(async () => {
      throw deniedError(['im:chat:readonly', 'im:chat', 'im:chat:read']);
    });
    const cache = new ChatModeCache();

    for (let i = 0; i < 5; i++) await cache.resolve(channel, `oc_${i % 2}`, 'p2p');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('lark-permission', 'scope-missing', {
      scopes: 'im:chat:readonly, im:chat, im:chat:read',
      api: 'im.v1.chat.get',
    });
    expect(getMissingScopes()).toEqual([['im:chat:readonly', 'im:chat', 'im:chat:read']]);
  });

  it('logs a different missing scope on its own line', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { channel, getChatMode } = fakeChannel(async () => {
      throw deniedError(['im:chat:readonly']);
    });
    const cache = new ChatModeCache();

    await cache.resolve(channel, 'oc_1', 'p2p');
    getChatMode.mockRejectedValueOnce(deniedError(['im:chat.group_info:readonly']));
    await cache.resolve(channel, 'oc_1', 'p2p');
    await cache.resolve(channel, 'oc_1', 'p2p');

    expect(warn.mock.calls.map((c) => (c[2] as { scopes: string }).scopes)).toEqual([
      'im:chat:readonly',
      'im:chat.group_info:readonly',
    ]);
  });
});
