import type { CardActionEvent } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

/**
 * A skill belongs to the agent, not the bridge, so the `/skills` card's run
 * button has no command handler to call — the click has to reach the agent
 * as if the user had typed `/<skill>`.
 */
describe('/skills card run button', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('queues the skill to the agent as a slash message', async () => {
    const h = await createHarness();

    await h.dispatch({ cmd: 'skills.run', arg: 'handoff' });

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('/handoff');
    expect(queued[0]?.chatType).toBe('group');
  });

  it('accepts a plugin-namespaced skill name', async () => {
    const h = await createHarness();

    await h.dispatch({ cmd: 'skills.run', arg: 'vercel:deploy' });

    expect(h.pending.cancel('oc_group')[0]?.content).toBe('/vercel:deploy');
  });

  it('drops a payload that is not a plain skill name', async () => {
    const h = await createHarness();

    await h.dispatch({ cmd: 'skills.run', arg: 'handoff && rm -rf /' });
    await h.dispatch({ cmd: 'skills.run', arg: 'two\nlines' });
    await h.dispatch({ cmd: 'skills.run', arg: '' });
    await h.dispatch({ cmd: 'skills.run' });

    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });

  it('ignores the click when the operator is not allowed in the chat', async () => {
    // A stranger, not the bot owner — the owner is allowed everywhere.
    const h = await createHarness({ allowedChats: ['oc_other'], operatorId: 'ou_stranger' });

    await h.dispatch({ cmd: 'skills.run', arg: 'handoff' });

    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });
});

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  pending: PendingQueue;
  dispatch(value: Record<string, unknown>): Promise<void>;
}

async function createHarness(
  opts: { allowedChats?: string[]; operatorId?: string } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile('skills-run-callback-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter();
  const pending = new PendingQueue(60_000, () => {});
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { allowedChats: opts.allowedChats ?? ['oc_group'] },
  });
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou_owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.profile}/config.json`,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  const chatModeCache = { resolve: async () => 'group' } as unknown as ChatModeCache;

  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    pending,
    dispatch: (value: Record<string, unknown>) =>
      handleCardAction({
        channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
        evt: {
          chatId: 'oc_group',
          messageId: 'om_card',
          operator: { openId: opts.operatorId ?? 'ou_owner', name: 'Operator' },
          action: { value },
        } as unknown as CardActionEvent,
        sessions,
        workspaces,
        activeRuns,
        agent,
        controls,
        pending,
        chatModeCache,
      }),
  };
}
