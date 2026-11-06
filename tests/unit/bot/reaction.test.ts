import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../../src/core/logger.js';
import { addWorkingReaction, createWorkingAck } from '../../../src/bot/reaction.js';

function fakeChannel(
  overrides: Partial<Record<'addReaction' | 'send' | 'recallMessage', unknown>>,
): LarkChannel {
  return overrides as unknown as LarkChannel;
}

afterEach(() => {
  vi.useRealTimers();
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

describe('createWorkingAck', () => {
  const sendOpts = { replyTo: 'om_1', replyInThread: true };

  function setup(send: unknown, recallMessage: unknown = vi.fn(async () => {})) {
    return createWorkingAck(fakeChannel({ send, recallMessage }), 'oc_1', 'om_1', sendOpts);
  }

  it('sends the ack as plain text with the given send options', async () => {
    const send = vi.fn(async () => ({ messageId: 'om_ack' }));
    const recallMessage = vi.fn(async () => {});
    const ack = setup(send, recallMessage);

    ack.send();
    await ack.beforeReply();

    expect(send).toHaveBeenCalledWith('oc_1', { text: '收到，正在处理…' }, sendOpts);
    expect(recallMessage).not.toHaveBeenCalled();
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
    const ack = setup(send);

    expect(() => ack.send()).not.toThrow();
    await expect(ack.beforeReply()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('reaction', 'ack-send-failed', {
      messageId: 'om_1',
      err: 'send failed',
    });
  });

  it('holds beforeReply until the ack lands', async () => {
    const landed = deferred<{ messageId: string }>();
    const recallMessage = vi.fn(async () => {});
    const ack = setup(() => landed.promise, recallMessage);
    const ready = vi.fn();

    ack.send();
    void ack.beforeReply().then(ready);
    await flushPromises();
    expect(ready).not.toHaveBeenCalled();

    landed.resolve({ messageId: 'om_ack' });
    await vi.waitFor(() => expect(ready).toHaveBeenCalled());
    expect(recallMessage).not.toHaveBeenCalled();
  });

  it('holds beforeReply until the reaction settles and its failure ack lands', async () => {
    const reaction = deferred<undefined>();
    const landed = deferred<{ messageId: string }>();
    const ack = setup(() => landed.promise);
    const ready = vi.fn();

    void ack.beforeReply(reaction.promise).then(ready);
    await flushPromises();
    expect(ready).not.toHaveBeenCalled();

    ack.send();
    reaction.resolve(undefined);
    await flushPromises();
    expect(ready).not.toHaveBeenCalled();

    landed.resolve({ messageId: 'om_ack' });
    await vi.waitFor(() => expect(ready).toHaveBeenCalled());
  });

  it('gives up after the grace period and recalls the ack when it lands late', async () => {
    vi.useFakeTimers();
    const landed = deferred<{ messageId: string }>();
    const recallMessage = vi.fn(async () => {});
    const ack = setup(() => landed.promise, recallMessage);
    const ready = vi.fn();

    ack.send();
    void ack.beforeReply().then(ready);
    await vi.advanceTimersByTimeAsync(2999);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ready).toHaveBeenCalled();
    expect(recallMessage).not.toHaveBeenCalled();

    landed.resolve({ messageId: 'om_ack' });
    await vi.advanceTimersByTimeAsync(0);
    expect(recallMessage).toHaveBeenCalledWith('om_ack');
  });

  it('only logs when the late ack cannot be recalled', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const landed = deferred<{ messageId: string }>();
    const ack = setup(
      () => landed.promise,
      vi.fn(async () => Promise.reject(new Error('recall failed'))),
    );

    ack.send();
    ack.close();
    landed.resolve({ messageId: 'om_ack' });

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('reaction', 'ack-recall-failed', {
        messageId: 'om_1',
        ackMessageId: 'om_ack',
        err: 'recall failed',
      }),
    );
  });

  it('sends nothing once the reply has started or the run is over', async () => {
    const send = vi.fn(async () => ({ messageId: 'om_ack' }));

    const afterReply = setup(send);
    await afterReply.beforeReply();
    afterReply.send();

    const afterClose = setup(send);
    afterClose.close();
    afterClose.send();

    expect(send).not.toHaveBeenCalled();
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
