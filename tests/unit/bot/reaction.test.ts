import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../../src/core/logger.js';
import { addWorkingReaction, sendWorkingAck } from '../../../src/bot/reaction.js';

function fakeChannel(overrides: Partial<Record<'addReaction' | 'send', unknown>>): LarkChannel {
  return overrides as unknown as LarkChannel;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('addWorkingReaction', () => {
  it('returns undefined and calls onFailure when the reaction is rejected', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const onFailure = vi.fn();
    const channel = fakeChannel({
      addReaction: async () => {
        throw new Error('Request failed with status code 400');
      },
    });

    await expect(addWorkingReaction(channel, 'om_1', onFailure)).resolves.toBeUndefined();

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'reaction',
      'add-failed',
      expect.objectContaining({ messageId: 'om_1' }),
    );
  });

  it('returns the reaction id and skips onFailure when the reaction is added', async () => {
    const onFailure = vi.fn();
    const channel = fakeChannel({ addReaction: async () => 'reaction_1' });

    await expect(addWorkingReaction(channel, 'om_1', onFailure)).resolves.toBe('reaction_1');

    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe('sendWorkingAck', () => {
  it('sends the ack as plain text with the given send options', async () => {
    const send = vi.fn(async () => ({ messageId: 'om_ack' }));
    const sendOpts = { replyTo: 'om_1', replyInThread: true };

    await sendWorkingAck(fakeChannel({ send }), 'oc_1', 'om_1', sendOpts);

    expect(send).toHaveBeenCalledWith('oc_1', { text: '收到，正在处理…' }, sendOpts);
  });

  it.each([
    ['rejects', vi.fn(async () => Promise.reject(new Error('send failed')))],
    [
      'throws synchronously',
      vi.fn(() => {
        throw new Error('send failed');
      }),
    ],
  ])('only logs when send %s', async (_name, send) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    await expect(
      sendWorkingAck(fakeChannel({ send }), 'oc_1', 'om_1', { replyTo: 'om_1' }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('reaction', 'ack-send-failed', {
      messageId: 'om_1',
      err: 'send failed',
    });
  });
});
