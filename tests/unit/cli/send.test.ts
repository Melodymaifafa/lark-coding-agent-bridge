import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LarkChannelOptions } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveRecipient, runSend } from '../../../src/cli/commands/send';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(admins: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-send-'));
  roots.push(root);
  const profile = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'plain-secret', tenant: 'feishu' } },
    access: { admins },
  });
  await saveRootConfig(createRootConfig('melody', profile), join(root, 'config.json'));
  const cardFile = join(root, 'card.json');
  await writeFile(cardFile, JSON.stringify({ elements: [] }));

  const calls: Array<{ opts: LarkChannelOptions; to: string; input: unknown }> = [];
  const factory = (opts: LarkChannelOptions) => ({
    async send(to: string, input: unknown) {
      calls.push({ opts, to, input });
      return { messageId: 'om_sent' };
    },
  });
  return { root, cardFile, calls, factory };
}

describe('send command', () => {
  it("sends the card file to the profile's first admin as that profile's app", async () => {
    const { root, cardFile, calls, factory } = await setup(['ou_admin', 'ou_second']);

    const messageId = await runSend({ card: cardFile, to: 'admin', profile: 'melody', rootDir: root }, factory);

    expect(messageId).toBe('om_sent');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe('ou_admin');
    expect(calls[0]?.input).toEqual({ card: { elements: [] } });
    expect(calls[0]?.opts).toMatchObject({
      appId: 'cli_test',
      appSecret: 'plain-secret',
      domain: 'https://open.feishu.cn',
    });
  });

  it('refuses a card file that is not a JSON object', async () => {
    const { root, cardFile, calls, factory } = await setup(['ou_admin']);
    await writeFile(cardFile, 'null');

    await expect(runSend({ card: cardFile, to: 'ou_x', profile: 'melody', rootDir: root }, factory))
      .rejects.toThrow('not a card JSON object');
    expect(calls).toEqual([]);
  });
});

describe('resolveRecipient', () => {
  it('passes explicit ids through and fails loudly when there is no admin', () => {
    expect(resolveRecipient('oc_chat', [])).toBe('oc_chat');
    expect(() => resolveRecipient('admin', [])).toThrow('no admin');
  });
});
