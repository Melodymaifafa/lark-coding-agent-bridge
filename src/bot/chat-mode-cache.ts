import type { ChatType, LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';
import { isPermissionDenied, missingScopes, warnMissingScopesOnce } from './lark-permission';

export type ChatMode = 'p2p' | 'group' | 'topic';

/**
 * In-memory cache for `channel.getChatMode()` results.
 *
 * Why: chat mode (`p2p` / `group` / `topic`) doesn't change within a chat's
 * lifetime — but the message event only carries `chatType` (`p2p` /
 * `group`), never whether a group is a topic group. The only way to know is
 * one extra `im.v1.chat.get` API call per chat. We cache by chatId so each
 * chat costs at most one round-trip after which it's all in-memory.
 *
 * On lookup failure (network / permission / unknown chatId) we fall back to
 * the event's own `chatType` when the caller passes it, else **'group'** —
 * the conservative default: "a normal chat, one session per chatId, no
 * thread split". Doesn't crash.
 */
export class ChatModeCache {
  private readonly cache = new Map<string, ChatMode>();

  async resolve(channel: LarkChannel, chatId: string, chatType?: ChatType): Promise<ChatMode> {
    const hit = this.cache.get(chatId);
    if (hit) return hit;
    try {
      const mode = await channel.getChatMode(chatId);
      this.cache.set(chatId, mode);
      log.info('chat', 'mode-resolved', { chatId, mode });
      return mode;
    } catch (err) {
      if (isPermissionDenied(err)) {
        warnMissingScopesOnce(missingScopes(err), 'im.v1.chat.get');
      } else {
        log.warn('chat', 'mode-resolve-failed', {
          chatId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      // Don't poison the cache — next message gets another try.
      return chatType ?? 'group';
    }
  }

  invalidate(chatId: string): void {
    this.cache.delete(chatId);
  }
}
