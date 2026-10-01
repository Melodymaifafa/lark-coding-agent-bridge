/**
 * The schema-1 Feishu card the knowledge-recall job pushes every morning
 * (`~/.claude/knowledge-recall/judge-and-card.py`, `render_lark_cards`):
 * `markdown` labels, `plain_text` bodies, and `card.swap` buttons whose
 * `value` carries the card id.
 *
 * Shared by the unit test that pins the SDK flattening (`fetchQuotedContext`)
 * and the integration test that pins what reaches the agent prompt, so both
 * assert against one card shape.
 */

/** What she originally asked, months ago — the card's `asked` field. */
export const RECALL_ASKED = 'feature/douyin-grabber 这种带斜杠的名字，是文件夹路径吗';

/** The quiz line. The workspace AGENTS.md matches this against `cards/*.json`. */
export const RECALL_QUESTION =
  'git 里像 feature/douyin-grabber 这种带斜杠的名字，指的到底是什么？';

export const RECALL_ANSWER =
  'feature/douyin-grabber 是 git 的分支名（= 同一文件夹里的一条改动线），不是路径。';

/** `<YYYY-MM-DD>_<card_id>`, as the swap buttons and clicks.jsonl spell it. */
export const RECALL_SWAP_ID = '2026-10-02_2026-09-22-02';

const HEADER_TITLE = '复习 · 第 2 次 · 9 月 22 日（10 天前）';

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
    value: { cmd: 'card.swap', deck: 'knowledge-recall', id: RECALL_SWAP_ID, state },
  };
}

/** The `q` state: question only, two reveal buttons. */
export function recallQuestionCard(): string {
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: HEADER_TITLE } },
    elements: [
      label('你当时想知道'),
      plain(RECALL_ASKED),
      label('考考你'),
      plain(RECALL_QUESTION),
      { tag: 'note', elements: [{ tag: 'plain_text', content: '先自己想一想，想好了再点。' }] },
      { tag: 'action', actions: [swapButton('给我提示', 'hint'), swapButton('看答案', 'answer')] },
    ],
  });
}

/** The `answer` state, i.e. what a reply quotes after she clicked 看答案. */
export function recallAnswerCard(): string {
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'green', title: { tag: 'plain_text', content: HEADER_TITLE } },
    elements: [
      label('你当时想知道'),
      plain(RECALL_ASKED),
      label('考考你'),
      plain(RECALL_QUESTION),
      { tag: 'hr' },
      label('答案'),
      plain(RECALL_ANSWER),
    ],
  });
}
