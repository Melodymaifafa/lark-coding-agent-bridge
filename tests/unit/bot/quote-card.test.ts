import type { ApiMessageItem, LarkChannel } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import { fetchQuotedContext, renderQuotedBlock } from '../../../src/bot/quote.js';

/**
 * MEL-274 — replying to a pushed card must tell the agent WHICH card.
 *
 * The knowledge-recall job (`~/.claude/knowledge-recall/judge-and-card.py`,
 * `render_lark_cards`) pushes a schema-1 card: `markdown` labels, `plain_text`
 * bodies, and `card.swap` buttons whose `value` carries the card id. The card
 * has text-bearing nodes, so the SDK flattens it instead of hitting the
 * `[interactive card]` placeholder path — the card's own words reach the agent,
 * but the id inside the button values does NOT. The workspace AGENTS.md tells
 * the agent to re-find the card by its `question` line, so these tests pin the
 * part it relies on: every line the card shows is in the quoted content.
 */

const ASKED = 'feature/douyin-grabber 这种带斜杠的名字，是文件夹路径吗';
const QUESTION = 'git 里像 feature/douyin-grabber 这种带斜杠的名字，指的到底是什么？';
const ANSWER = 'feature/douyin-grabber 是 git 的分支名（= 同一文件夹里的一条改动线），不是路径。';
const SWAP_ID = '2026-10-02_2026-09-22-02';

function label(text: string): unknown {
  return { tag: 'markdown', content: `**${text}**` };
}

function plain(text: string): unknown {
  return { tag: 'div', text: { tag: 'plain_text', content: text } };
}

function swapButton(text: string, state: string): unknown {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type: 'primary',
    value: { cmd: 'card.swap', deck: 'knowledge-recall', id: SWAP_ID, state },
  };
}

/** The `q` state: question only, two reveal buttons. */
function questionCard(): string {
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '复习 · 第 2 次 · 9 月 22 日（10 天前）' },
    },
    elements: [
      label('你当时想知道'),
      plain(ASKED),
      label('考考你'),
      plain(QUESTION),
      { tag: 'note', elements: [{ tag: 'plain_text', content: '先自己想一想，想好了再点。' }] },
      { tag: 'action', actions: [swapButton('给我提示', 'hint'), swapButton('看答案', 'answer')] },
    ],
  });
}

/** The `answer` state, i.e. what a reply quotes after she clicked 看答案. */
function answerCard(): string {
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '复习 · 第 2 次 · 9 月 22 日（10 天前）' },
    },
    elements: [
      label('你当时想知道'),
      plain(ASKED),
      label('考考你'),
      plain(QUESTION),
      { tag: 'hr' },
      label('答案'),
      plain(ANSWER),
    ],
  });
}

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
    const quoted = await fetchQuotedContext(channelReturning(questionCard()), 'om_card');

    expect(quoted).toBeDefined();
    expect(quoted?.rawContentType).toBe('interactive');
    expect(quoted?.content).not.toContain('[interactive card]');
    // The line AGENTS.md matches cards/*.json on.
    expect(quoted?.content).toContain(QUESTION);
    expect(quoted?.content).toContain(ASKED);
  });

  it('carries the revealed answer once she has clicked 看答案', async () => {
    const quoted = await fetchQuotedContext(channelReturning(answerCard()), 'om_card');

    expect(quoted?.content).toContain(QUESTION);
    expect(quoted?.content).toContain(ANSWER);
  });

  it('does not expose the card id, so AGENTS.md has to match on the question', async () => {
    const quoted = await fetchQuotedContext(channelReturning(questionCard()), 'om_card');

    // Documents the gap rather than asserting it is fine: the id lives in the
    // button `value`, which the SDK's flattening drops. Flip this test the day
    // the id is surfaced on purpose.
    expect(quoted?.content).not.toContain(SWAP_ID);
  });

  it('renders into a prompt block tagged with the quoted message id', async () => {
    const quoted = await fetchQuotedContext(channelReturning(questionCard()), 'om_card');
    const block = renderQuotedBlock(quoted ? [quoted] : []);

    expect(block).toContain('<quoted_message id="om_card"');
    expect(block).toContain('type="interactive"');
    expect(block).toContain(QUESTION);
  });
});
