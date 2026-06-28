import { describe, expect, it } from 'vitest';
import {
  COMMAND_REGISTRY,
  allCommandTokens,
  matchCommands,
} from '../../../src/commands/registry.js';
import { commandMatchCard, helpCard } from '../../../src/card/templates.js';

describe('command registry', () => {
  it('exposes every command with a one-line summary', () => {
    expect(COMMAND_REGISTRY.length).toBeGreaterThan(0);
    for (const spec of COMMAND_REGISTRY) {
      expect(spec.name).toMatch(/^[a-z]+$/);
      expect(spec.summary.length).toBeGreaterThan(0);
    }
  });

  it('matches commands by name or alias prefix, ignoring leading slash', () => {
    expect(matchCommands('he').map((s) => s.name)).toEqual(['help']);
    expect(matchCommands('/he').map((s) => s.name)).toEqual(['help']);
    // `/re` matches /reset (alias of new), /resume, /remove, /reconnect.
    expect(matchCommands('re').map((s) => s.name).sort()).toEqual(
      ['new', 'reconnect', 'remove', 'resume'].sort(),
    );
  });

  it('treats empty / whitespace partials as no match', () => {
    expect(matchCommands('')).toEqual([]);
    expect(matchCommands('/')).toEqual([]);
    expect(matchCommands('  ')).toEqual([]);
  });

  it('returns no matches for an unknown prefix', () => {
    expect(matchCommands('zzz')).toEqual([]);
  });

  it('includes aliases in the token list', () => {
    expect(allCommandTokens()).toContain('/new');
    expect(allCommandTokens()).toContain('/reset');
  });
});

describe('help card auto-generation', () => {
  it('lists every registry command (no hand-copied list)', () => {
    const json = JSON.stringify(helpCard('Claude'));
    for (const spec of COMMAND_REGISTRY) {
      expect(json).toContain(`/${spec.name}`);
    }
  });

  it('marks admin commands with a lock', () => {
    const json = JSON.stringify(helpCard());
    expect(json).toContain('🔒');
  });
});

describe('command match card', () => {
  it('lists matches and offers a run button for argument-free commands', () => {
    const json = JSON.stringify(commandMatchCard('/st', matchCommands('st')));
    // /status and /stop both match.
    expect(json).toContain('/status');
    expect(json).toContain('/stop');
    // status takes no args → has a run button dispatching cmd:status.
    expect(json).toContain('"cmd":"status"');
  });

  it('shows a usage hint instead of a run button for arg-taking commands', () => {
    const json = JSON.stringify(commandMatchCard('/cd', matchCommands('cd')));
    expect(json).toContain('/cd');
    expect(json).toContain('需要参数');
    expect(json).not.toContain('"cmd":"cd"');
  });
});
