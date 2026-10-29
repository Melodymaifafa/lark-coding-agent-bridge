import type { RuntimeControls } from './access';
import { log } from '../core/logger';
import { isPermissionDenied, missingScopes } from '../bot/lark-permission';

export const OWNER_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export interface AppInfoSource {
  getAppInfo(opts?: {
    lang?: 'zh_cn' | 'en_us' | 'ja_jp';
    userIdType?: 'open_id' | 'user_id' | 'union_id';
  }): Promise<{ ownerId?: string }>;
}

export interface OwnerRefreshControllerOptions {
  controls: RuntimeControls;
  source: AppInfoSource;
  appId: string;
  intervalMs?: number;
}

export interface OwnerRefreshController {
  start(): Promise<void>;
  stop(): void;
}

// A missing scope fails the same way on every call, so after the first denial
// an app is not asked again until the bridge restarts. Keyed by appId so an
// in-process reconnect (fresh controls) does not log it a second time.
const deniedApps = new Map<string, string>();

function isOwnerRefreshDenied(appId: string): boolean {
  return deniedApps.has(appId);
}

export function resetOwnerRefreshDenialsForTest(): void {
  deniedApps.clear();
}

export async function refreshOwnerControls(
  controls: RuntimeControls,
  source: AppInfoSource,
  appId: string,
): Promise<void> {
  const deniedError = deniedApps.get(appId);
  if (deniedError !== undefined) {
    controls.ownerRefreshState = 'failed';
    controls.ownerRefreshError = deniedError;
    return;
  }
  try {
    const ownerId = await fetchOwnerId(source);
    controls.botOwnerId = ownerId;
    controls.ownerRefreshState = 'ok';
    controls.ownerRefreshedAt = Date.now();
    delete controls.ownerRefreshError;
  } catch (err) {
    controls.ownerRefreshState = 'failed';
    controls.ownerRefreshedAt = Date.now();
    controls.ownerRefreshError = err instanceof Error ? err.message : String(err);
    const denied = isPermissionDenied(err);
    if (denied) deniedApps.set(appId, controls.ownerRefreshError);
    log.warn('access', 'owner_refresh_failed', {
      appId,
      error: controls.ownerRefreshError,
      ...(denied
        ? { missingScopes: missingScopes(err).join(', ') || 'unknown', retry: 'off until restart' }
        : {}),
    });
  }
}

export function createOwnerRefreshController(
  opts: OwnerRefreshControllerOptions,
): OwnerRefreshController {
  let timer: ReturnType<typeof setInterval> | undefined;
  const intervalMs = opts.intervalMs ?? OWNER_REFRESH_INTERVAL_MS;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  return {
    async start(): Promise<void> {
      await refreshOwnerControls(opts.controls, opts.source, opts.appId);
      if (isOwnerRefreshDenied(opts.appId)) return;
      timer = setInterval(() => {
        void refreshOwnerControls(opts.controls, opts.source, opts.appId).then(() => {
          if (isOwnerRefreshDenied(opts.appId)) stop();
        });
      }, intervalMs);
    },
    stop,
  };
}

async function fetchOwnerId(source: AppInfoSource): Promise<string> {
  const { ownerId } = await source.getAppInfo({
    lang: 'zh_cn',
    userIdType: 'open_id',
  });
  if (!ownerId) throw new Error('application owner missing from API response');
  return ownerId;
}
