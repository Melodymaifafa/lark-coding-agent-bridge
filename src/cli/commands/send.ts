import { readFile } from 'node:fs/promises';
import { createLarkChannel, type LarkChannelOptions } from '@larksuite/channel';
import { resolveAppPaths } from '../../config/app-paths';
import { paths } from '../../config/paths';
import { loadRootConfig, readActiveProfile, runtimeProfileConfig } from '../../config/profile-store';
import { resolveAppSecret } from '../../config/secret-resolver';

export interface SendCommandOptions {
  card: string;
  to: string;
  profile?: string;
  rootDir?: string;
}

type ChannelFactory = (opts: LarkChannelOptions) => Pick<ReturnType<typeof createLarkChannel>, 'send'>;

const silent = () => {};

/**
 * `send` — push one card as a profile's bot, print its message_id, exit.
 * For external programs (e.g. a daily job) whose buttons the running bridge
 * then answers (see card/swap.ts). REST only, no WebSocket, so it runs fine
 * next to the live bridge process.
 */
export async function runSend(
  opts: SendCommandOptions,
  createChannel: ChannelFactory = createLarkChannel,
): Promise<string> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const root = await loadRootConfig(resolveAppPaths({ rootDir }).configFile);
  if (!root) throw new Error(`config not found under ${rootDir}`);
  const profile = opts.profile ?? (await readActiveProfile(rootDir)) ?? root.activeProfile;
  const cfg = runtimeProfileConfig(root, profile);
  const to = resolveRecipient(opts.to, cfg.access.admins);

  const card: unknown = JSON.parse(await readFile(opts.card, 'utf8'));
  if (!card || typeof card !== 'object') throw new Error(`not a card JSON object: ${opts.card}`);

  const channel = createChannel({
    appId: cfg.accounts.app.id,
    appSecret: await resolveAppSecret(cfg, resolveAppPaths({ rootDir, profile })),
    domain:
      cfg.accounts.app.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
    source: 'lark-channel-bridge',
    // stdout carries only the message_id; SDK errors still surface as a thrown error.
    logger: { error: silent, warn: silent, info: silent, debug: silent, trace: silent },
  });
  const { messageId } = await channel.send(to, { card });
  return messageId;
}

/** `admin` means the profile's first admin; anything else is passed through as an id. */
export function resolveRecipient(to: string, admins: readonly string[]): string {
  if (to !== 'admin') return to;
  const first = admins[0];
  if (!first) throw new Error('--to admin: this profile has no admin; pass an open_id instead');
  return first;
}
