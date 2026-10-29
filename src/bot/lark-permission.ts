import { log } from '../core/logger';

/** Feishu's "the app lacks a scope for this API" code. */
const PERMISSION_DENIED_CODE = 99991672;

interface FeishuErrorBody {
  code?: unknown;
  msg?: unknown;
  error?: { permission_violations?: Array<{ subject?: unknown }> };
}

/**
 * node-sdk rethrows the AxiosError, so Feishu's `{ code, msg, error }` sits
 * at `err.response.data`. The SDK logger also passes that body on its own.
 */
function feishuBody(err: unknown): FeishuErrorBody | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  if (data && typeof data === 'object') return data as FeishuErrorBody;
  return typeof (err as FeishuErrorBody).code === 'number' ? (err as FeishuErrorBody) : undefined;
}

export function isPermissionDenied(err: unknown): boolean {
  return feishuBody(err)?.code === PERMISSION_DENIED_CODE;
}

/**
 * Scope names Feishu says would let the call through — granting any ONE of
 * them is enough. `[]` when the error names none.
 */
export function missingScopes(err: unknown): string[] {
  const body = feishuBody(err);
  if (!body) return [];
  const subjects = (body.error?.permission_violations ?? [])
    .map((v) => v.subject)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (subjects.length > 0) return [...new Set(subjects)];
  const listed = typeof body.msg === 'string' ? /scopes is required: \[([^\]]+)\]/.exec(body.msg) : null;
  if (!listed?.[1]) return [];
  return [...new Set(listed[1].split(',').map((s) => s.trim()).filter(Boolean))];
}

// Keyed by the sorted scope set; lives until restart, so a scope granted
// mid-run keeps showing until the bridge restarts.
const reported = new Map<string, string[]>();

/** Log one warn per missing scope set per process and remember it for /status. */
export function warnMissingScopesOnce(scopes: readonly string[], api: string): void {
  const key = [...scopes].sort().join(',');
  if (reported.has(key)) return;
  reported.set(key, [...scopes]);
  log.warn('lark-permission', 'scope-missing', {
    scopes: scopes.length > 0 ? scopes.join(', ') : 'unknown',
    api,
  });
}

/** Missing scope sets seen so far; grant any one scope of each set. */
export function getMissingScopes(): string[][] {
  const sets = [...reported.values()].filter((s) => s.length > 0);
  // Any scope of a smaller set also fixes each superset of it.
  return sets.filter(
    (s) => !sets.some((o) => o.length < s.length && o.every((x) => s.includes(x))),
  );
}

export function resetMissingScopesForTest(): void {
  reported.clear();
}
