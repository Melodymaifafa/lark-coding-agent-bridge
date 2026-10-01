import { describe, expect, it } from 'vitest';
import { readSkillListing, translateEvent } from '../../../src/agent/claude/stream-json.js';

/**
 * Claude Code's `system/init` line is the bridge's source for "what skills
 * does this agent have right now" — it is structured protocol output the
 * bridge already receives on every run, not scraped prose.
 */
describe('claude init skill listing', () => {
  it('carries skill names and plugin paths through translateEvent', () => {
    const [evt] = [
      ...translateEvent({
        type: 'system',
        subtype: 'init',
        session_id: 's-1',
        cwd: '/repo',
        model: 'sonnet',
        skills: ['handoff', 'vercel:deploy'],
        plugins: [{ name: 'vercel', path: '/plugins/vercel', version: '1.0.0' }],
      }),
    ];

    expect(evt).toEqual({
      type: 'system',
      sessionId: 's-1',
      cwd: '/repo',
      model: 'sonnet',
      skills: {
        names: ['handoff', 'vercel:deploy'],
        plugins: [{ name: 'vercel', path: '/plugins/vercel' }],
      },
    });
  });

  it('omits the listing when the CLI does not report skills', () => {
    // An older CLI has no `skills` field. Absent must stay absent so
    // /skills can say "couldn't ask" instead of "there are none".
    const [evt] = [...translateEvent({ type: 'system', subtype: 'init', session_id: 's-2' })];
    expect(evt).toEqual({ type: 'system', sessionId: 's-2', cwd: undefined, model: undefined });
    expect(readSkillListing({})).toBeUndefined();
  });

  it('reports an empty list as empty, not as missing', () => {
    expect(readSkillListing({ skills: [] })).toEqual({ names: [], plugins: [] });
  });

  it('drops malformed entries instead of throwing', () => {
    expect(
      readSkillListing({
        skills: ['ok', '', 42, null],
        plugins: [{ name: 'p' }, { path: '/x' }, null, { name: 'q', path: '/q' }],
      }),
    ).toEqual({ names: ['ok'], plugins: [{ name: 'q', path: '/q' }] });
  });
});
