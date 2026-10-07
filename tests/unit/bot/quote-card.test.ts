import type { ApiMessageItem, LarkChannel } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import { fetchQuotedContext } from '../../../src/bot/quote.js';
import {
  RECALL_ANSWER,
  RECALL_ASKED,
  RECALL_QUESTION,
  RECALL_SWAP_ID,
  recallAnswerCard,
  recallQuestionCard,
} from '../../helpers/knowledge-recall-card.js';

/**
 * MEL-274 — replying to a pushed card must tell the agent WHICH card.
 *
 * This file covers the first hop only: the SDK flattening inside
 * `fetchQuotedContext` (the production fetch entry, `src/bot/channel.ts:662`).
 * The recall card has text-bearing nodes, so the SDK flattens it instead of
 * hitting the `[interactive card]` placeholder path — the card's own words
 * reach the agent, but the id inside the button values does NOT. The workspace
 * AGENTS.md tells the agent to re-find the card by its `question` line, so
 * these tests pin the part it relies on.
 *
 * The second hop — that this content actually lands in the prompt handed to
 * the agent — is pinned end-to-end in
 * `tests/integration/bot/quote-recall-card.test.ts`.
 */

function channelReturning(content: string): LarkChannel {
  const item: ApiMessageItem = {
    message_id: 'om_card',
    msg_type: 'interactive',
    create_time: '1790000000000',
    sender: { id: 'ou_bot' },
    body: { content },
  } as ApiMessageItem;
  return {
    botIdentity: { openId: 'ou_bot', name: 'Melody的Codex Agent' },
    fetchRawMessage: async () => [item],
  } as unknown as LarkChannel;
}

describe('quoting a knowledge-recall card', () => {
  it('carries the card text — not the [interactive card] placeholder', async () => {
    const quoted = await fetchQuotedContext(channelReturning(recallQuestionCard()), 'om_card');

    expect(quoted).toBeDefined();
    expect(quoted?.rawContentType).toBe('interactive');
    expect(quoted?.content).not.toContain('[interactive card]');
    // The line AGENTS.md matches cards/*.json on.
    expect(quoted?.content).toContain(RECALL_QUESTION);
    expect(quoted?.content).toContain(RECALL_ASKED);
  });

  it('carries the revealed answer once she has clicked 看答案', async () => {
    const quoted = await fetchQuotedContext(channelReturning(recallAnswerCard()), 'om_card');

    expect(quoted?.content).toContain(RECALL_QUESTION);
    expect(quoted?.content).toContain(RECALL_ANSWER);
  });

  it('does not expose the card id, so AGENTS.md has to match on the question', async () => {
    const quoted = await fetchQuotedContext(channelReturning(recallQuestionCard()), 'om_card');

    // Documents the gap rather than asserting it is fine: the id lives in the
    // button `value`, which the SDK's flattening drops. Flip this test the day
    // the id is surfaced on purpose.
    expect(quoted?.content).not.toContain(RECALL_SWAP_ID);
  });
});
