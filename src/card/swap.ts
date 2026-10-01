import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import { paths } from '../config/paths';
import { log } from '../core/logger';

/**
 * Card swap: an external program (e.g. a daily scheduled job) pushes a card
 * with `lark-channel-bridge send`, writes the card's other states as JSON
 * files, and a button click replaces the card in place with one of them.
 * The bridge never builds the content; it only swaps files.
 *
 *   button value  { cmd: 'card.swap', deck, id, state }
 *   state file    <root>/<deck>/<id>.<state>.json
 *   click log     <root>/<deck>/clicks.jsonl   (one line per swap that landed)
 */
export const CARD_SWAP_CMD = 'card.swap';
export const DEFAULT_CARD_SWAP_ROOT = join(paths.rootDir, 'card-swap');

// Lark keeps a clicked card locked until the callback handler returns, then
// repaints it from its cache; an update that lands before that is lost.
// Same cause as FORM_SETTLE_MS in commands/index.ts.
const SETTLE_MS = 600;

// Each field becomes one path segment: no slashes, no dots, so no `..`.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export interface CardSwapRequest {
  deck: string;
  id: string;
  state: string;
}

export interface CardSwapOptions {
  root?: string;
  settleMs?: number;
  now?: () => Date;
}

export function parseCardSwap(payload: Record<string, unknown>): CardSwapRequest | undefined {
  const { deck, id, state } = payload;
  if (typeof deck !== 'string' || typeof id !== 'string' || typeof state !== 'string') {
    return undefined;
  }
  if (![deck, id, state].every((part) => SEGMENT.test(part))) return undefined;
  return { deck, id, state };
}

/** Replace the clicked card with its pre-rendered `state`. False when the state file is missing or broken. */
export async function swapCard(
  channel: Pick<LarkChannel, 'updateCard'>,
  messageId: string,
  req: CardSwapRequest,
  opts: CardSwapOptions = {},
): Promise<boolean> {
  const deckDir = join(opts.root ?? DEFAULT_CARD_SWAP_ROOT, req.deck);
  let card: unknown;
  try {
    card = JSON.parse(await readFile(join(deckDir, `${req.id}.${req.state}.json`), 'utf8'));
  } catch (err) {
    log.warn('cardSwap', 'state-unreadable', { ...req, err: String(err) });
    return false;
  }
  if (!card || typeof card !== 'object') {
    log.warn('cardSwap', 'state-not-object', { ...req });
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, opts.settleMs ?? SETTLE_MS));
  await channel.updateCard(messageId, card);
  const at = (opts.now?.() ?? new Date()).toISOString();
  await appendFile(
    join(deckDir, 'clicks.jsonl'),
    `${JSON.stringify({ at, id: req.id, state: req.state })}\n`,
  );
  log.info('cardSwap', 'swapped', { ...req });
  return true;
}
