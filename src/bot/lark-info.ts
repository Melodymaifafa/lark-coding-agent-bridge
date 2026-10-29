import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';
import { isPermissionDenied, missingScopes } from './lark-permission';

export const KNOWN_CHATS_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export interface KnownChat {
  id: string;
  name: string;
}

// A missing scope fails the same way on every call, so after the first denial
// an app's chat list is not asked for again until the bridge restarts. Keyed
// by appId so `/account change` to an app that has the scope still lists chats.
const deniedApps = new Set<string>();

export function resetKnownChatsDenialForTest(): void {
  deniedApps.clear();
}

export async function fetchKnownChats(channel: LarkChannel, appId: string): Promise<KnownChat[]> {
  if (deniedApps.has(appId)) return [];
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
    if (denied) deniedApps.add(appId);
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
  appId: string,
  controls: { knownChats?: KnownChat[] },
  intervalMs = KNOWN_CHATS_REFRESH_INTERVAL_MS,
): { stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const refresh = async (): Promise<void> => {
    const chats = await fetchKnownChats(channel, appId);
    if (chats.length > 0) {
      controls.knownChats = chats;
    }
    if (deniedApps.has(appId)) stop();
  };
  void refresh();
  timer = setInterval(() => void refresh(), intervalMs);
  return { stop };
}
