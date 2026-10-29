import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';
import { isPermissionDenied, missingScopes } from './lark-permission';

export const KNOWN_CHATS_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export interface KnownChat {
  id: string;
  name: string;
}

// A missing scope fails the same way on every call, so after the first denial
// the chat list is not asked for again until the bridge restarts.
let chatsDenied = false;

export function resetKnownChatsDenialForTest(): void {
  chatsDenied = false;
}

export async function fetchKnownChats(channel: LarkChannel): Promise<KnownChat[]> {
  if (chatsDenied) return [];
  try {
    const summaries = await channel.listChats({ pageSize: 100, maxPages: 5 });
    const chats: KnownChat[] = summaries.map((c) => ({
      id: c.id,
      name: c.name || '(无名)',
    }));
    log.info('lark-info', 'chats-fetched', { count: chats.length });
    return chats;
  } catch (err) {
    const denied = isPermissionDenied(err);
    if (denied) chatsDenied = true;
    log.warn('lark-info', 'chats-fetch-failed', {
      err: err instanceof Error ? err.message : String(err),
      ...(denied
        ? { missingScopes: missingScopes(err).join(', ') || 'unknown', retry: 'off until restart' }
        : {}),
    });
    return [];
  }
}

export function startKnownChatsRefreshTimer(
  channel: LarkChannel,
  controls: { knownChats?: KnownChat[] },
  intervalMs = KNOWN_CHATS_REFRESH_INTERVAL_MS,
): { stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const refresh = async (): Promise<void> => {
    const chats = await fetchKnownChats(channel);
    if (chats.length > 0) {
      controls.knownChats = chats;
    }
    if (chatsDenied) stop();
  };
  void refresh();
  timer = setInterval(() => void refresh(), intervalMs);
  return { stop };
}
