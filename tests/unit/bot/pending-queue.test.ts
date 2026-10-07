import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingQueue } from '../../../src/bot/pending-queue.js';

function msg(id: string): NormalizedMessage {
  return { messageId: id } as unknown as NormalizedMessage;
}

describe('PendingQueue.cancelOnly', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops what was queued before a slow command, keeping what arrived during it', () => {
    // `/skills` on a cold cache can take seconds; a message sent while it
    // runs must still be flushed to the agent, not silently discarded.
    const flushed: string[][] = [];
    const pending = new PendingQueue(600, (_scope, batch) => {
      flushed.push(batch.map((m) => m.messageId));
    });
    pending.push('oc_a', msg('before'));
    const queuedBefore = pending.peek('oc_a');
    pending.push('oc_a', msg('during'));

    const dropped = pending.cancelOnly('oc_a', queuedBefore);
    expect(dropped.map((m) => m.messageId)).toEqual(['before']);

    vi.advanceTimersByTime(600);
    expect(flushed).toEqual([['during']]);
  });

  it('clears the scope when everything queued is dropped', () => {
    const onFlush = vi.fn();
    const pending = new PendingQueue(600, onFlush);
    pending.push('oc_a', msg('before'));

    expect(pending.cancelOnly('oc_a', pending.peek('oc_a'))).toHaveLength(1);
    vi.advanceTimersByTime(600);
    expect(onFlush).not.toHaveBeenCalled();
    expect(pending.peek('oc_a')).toEqual([]);
  });
});
