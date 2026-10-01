import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCardSwap, swapCard } from '../../../src/card/swap';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function deckRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'card-swap-'));
  roots.push(root);
  await mkdir(join(root, 'quiz'));
  return root;
}

function fakeChannel() {
  const patched: Array<{ messageId: string; card: unknown }> = [];
  return {
    patched,
    async updateCard(messageId: string, card: object) {
      patched.push({ messageId, card });
    },
  };
}

describe('parseCardSwap', () => {
  it('accepts plain deck / id / state names', () => {
    expect(parseCardSwap({ cmd: 'card.swap', deck: 'quiz', id: '2026-10-02_2026-09-28-01', state: 'hint' }))
      .toEqual({ deck: 'quiz', id: '2026-10-02_2026-09-28-01', state: 'hint' });
  });

  it.each([
    { deck: '../etc', id: 'a', state: 'hint' },
    { deck: 'quiz', id: 'a/b', state: 'hint' },
    { deck: 'quiz', id: '..', state: 'hint' },
    { deck: 'quiz', id: 'a', state: 'hint.json' },
    { deck: 'quiz', id: '', state: 'hint' },
    { deck: 'quiz', id: 7, state: 'hint' },
    { deck: 'quiz', state: 'hint' },
  ])('rejects %o', (payload) => {
    expect(parseCardSwap(payload)).toBeUndefined();
  });
});

describe('swapCard', () => {
  it('replaces the clicked card with the state file and logs the click', async () => {
    const root = await deckRoot();
    const card = { header: { title: { content: 'hint' } } };
    await writeFile(join(root, 'quiz', 'day1.hint.json'), JSON.stringify(card));
    const channel = fakeChannel();

    const ok = await swapCard(channel, 'om_1', { deck: 'quiz', id: 'day1', state: 'hint' }, {
      root,
      settleMs: 0,
      now: () => new Date('2026-10-02T01:20:00Z'),
    });

    expect(ok).toBe(true);
    expect(channel.patched).toEqual([{ messageId: 'om_1', card }]);
    const clicks = await readFile(join(root, 'quiz', 'clicks.jsonl'), 'utf8');
    expect(clicks).toBe('{"at":"2026-10-02T01:20:00.000Z","id":"day1","state":"hint"}\n');
  });

  it('leaves the card alone when the state file is missing or not an object', async () => {
    const root = await deckRoot();
    await writeFile(join(root, 'quiz', 'day1.answer.json'), '"just a string"');
    const channel = fakeChannel();

    expect(await swapCard(channel, 'om_1', { deck: 'quiz', id: 'day1', state: 'hint' }, { root, settleMs: 0 }))
      .toBe(false);
    expect(await swapCard(channel, 'om_1', { deck: 'quiz', id: 'day1', state: 'answer' }, { root, settleMs: 0 }))
      .toBe(false);
    expect(channel.patched).toEqual([]);
  });
});
