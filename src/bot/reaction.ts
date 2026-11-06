import type { LarkChannel, SendOptions } from '@larksuite/channel';
import { log } from '../core/logger';

const WORKING_ACK_TEXT = '收到，正在处理…';

/**
 * Add a "Typing" reaction (敲键盘) to a message to give text-mode users an
 * instant "I got your message and I'm responding" cue while Claude is still
 * thinking. Matches the conventional Feishu UX for "the other side is
 * replying". Card mode doesn't need this — the streaming card already
 * shows a "正在思考…" footer the moment it's posted.
 *
 * Returns the reaction id on success, undefined on any failure. Failures
 * are logged but never thrown — losing a decoration must not break the
 * actual reply flow. `onFailure` lets the caller give the same cue another
 * way, and must not throw.
 */
export async function addWorkingReaction(
  channel: LarkChannel,
  messageId: string,
  onFailure?: () => void,
): Promise<string | undefined> {
  try {
    const id = await channel.addReaction(messageId, 'Typing');
    if (id) log.info('reaction', 'added', { messageId, reactionId: id });
    return id;
  } catch (err) {
    log.warn('reaction', 'add-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    onFailure?.();
    return undefined;
  }
}

/** Send the text stand-in for a reaction that could not be added. Failures
 * are logged but never thrown — the actual reply must still go out. */
export async function sendWorkingAck(
  channel: LarkChannel,
  chatId: string,
  messageId: string,
  sendOpts: SendOptions,
): Promise<void> {
  try {
    await channel.send(chatId, { text: WORKING_ACK_TEXT }, sendOpts);
    log.info('reaction', 'ack-sent', { messageId });
  } catch (err) {
    log.warn('reaction', 'ack-send-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Remove a previously-added reaction. Tolerates errors silently — best
 * effort cleanup; a leftover reaction is harmless. */
export async function removeReaction(
  channel: LarkChannel,
  messageId: string,
  reactionId: string,
): Promise<void> {
  try {
    await channel.removeReaction(messageId, reactionId);
    log.info('reaction', 'removed', { messageId, reactionId });
  } catch (err) {
    log.warn('reaction', 'remove-failed', {
      messageId,
      reactionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
