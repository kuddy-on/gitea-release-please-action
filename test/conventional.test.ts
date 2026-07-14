import { describe, expect, it } from 'vitest';

import { parseChanges, requiredBump } from '../src/conventional.js';
import type { RepositoryCommit } from '../src/types.js';

function commit(message: string, sha = message.slice(0, 7).padEnd(7, '0')): RepositoryCommit {
  return {
    sha,
    html_url: `https://gitea.example/acme/demo/commit/${sha}`,
    commit: { message },
    parents: [],
  };
}

describe('Conventional Commit parsing', () => {
  it('maps releasable types and ignores non-releasable commits', () => {
    const changes = parseChanges([
      commit('feat(api): add search', '1111111'),
      commit('fix: stop crashing', '2222222'),
      commit('perf: reduce allocations', '3333333'),
      commit('deps: update parser', '4444444'),
      commit('docs: clarify setup', '5555555'),
      commit('not conventional', '6666666'),
    ]);

    expect(changes.map((change) => change.type)).toEqual(['feat', 'fix', 'perf', 'deps']);
    expect(changes[0]).toMatchObject({ scope: 'api', subject: 'add search' });
    expect(requiredBump(changes)).toBe('minor');
  });

  it('treats bang and breaking footers as major releases for any type', () => {
    const changes = parseChanges([
      commit('fix!: remove legacy endpoint', 'aaaaaaa'),
      commit(
        'refactor(core): replace storage\n\nBREAKING CHANGE: old data must be migrated',
        'bbbbbbb',
      ),
    ]);

    expect(changes).toHaveLength(2);
    expect(changes.every((change) => change.breaking)).toBe(true);
    expect(changes[1]?.breakingNotes).toEqual(['old data must be migrated']);
    expect(requiredBump(changes)).toBe('major');
  });

  it('returns no bump when there are no releasable changes', () => {
    expect(requiredBump(parseChanges([commit('chore: tidy files')]))).toBeNull();
  });
});
