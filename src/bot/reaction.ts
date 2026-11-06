import type { LarkChannel, SendOptions } from '@larksuite/channel';
import { log } from '../core/logger';

const WORKING_ACK_TEXT = '收到，正在处理…';
// Long enough for the SDK's retries of a transient send failure (0.5s + 1.5s),
// short enough that a hung ack barely delays the reply.
const WORKING_ACK_GRACE_MS = 3000;

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

export interface WorkingAck {
  /** Send the ack. Does nothing once the reply has started. Never throws. */
  send(): void;
  /**
   * Resolves when the reply may go out: `reaction` has settled and the ack, if
   * any, has landed. Gives up after WORKING_ACK_GRACE_MS. Never rejects.
   */
  beforeReply(reaction?: Promise<unknown>): Promise<void>;
  /** The run is over: send no ack from now on. */
  close(): void;
}

/**
 * The text stand-in for a reaction that could not be added. Under a finished
 * reply, "正在处理" would tell the user to keep waiting, so the reply waits
 * for the ack through `beforeReply`. The wait is bounded because the reply
 * matters more, and a send can't be cancelled, so an ack that lands after the
 * wait is recalled. Failures are logged but never thrown.
 */
export function createWorkingAck(
  channel: LarkChannel,
  chatId: string,
  messageId: string,
  sendOpts: SendOptions,
): WorkingAck {
  let closed = false;
  let inFlight: Promise<void> = Promise.resolve();

  const sendAck = async (): Promise<void> => {
    try {
      const sent = await channel.send(chatId, { text: WORKING_ACK_TEXT }, sendOpts);
      log.info('reaction', 'ack-sent', { messageId });
      if (closed) await recallLateAck(channel, messageId, sent.messageId);
    } catch (err) {
      log.warn('reaction', 'ack-send-failed', {
        messageId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    send() {
      if (!closed) inFlight = sendAck();
    },
    async beforeReply(reaction) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.resolve(reaction).then(() => inFlight),
        new Promise((resolve) => {
          timer = setTimeout(resolve, WORKING_ACK_GRACE_MS);
        }),
      ]);
      clearTimeout(timer);
      closed = true;
    },
    close() {
      closed = true;
    },
  };
}

async function recallLateAck(
  channel: LarkChannel,
  messageId: string,
  ackMessageId: string,
): Promise<void> {
  try {
    await channel.recallMessage(ackMessageId);
    log.info('reaction', 'ack-recalled', { messageId, ackMessageId });
  } catch (err) {
    log.warn('reaction', 'ack-recall-failed', {
      messageId,
      ackMessageId,
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
