import { describe, expect, it } from 'vitest';
import { qaVersionSuggestions } from '@/lib/qa/versions';

describe('QA recorded product-version suggestions', () => {
  it('combines observed, candidate and previously tested builds only in the requested scope', () => {
    const sources = [
      { workspaceId: 'w1', projectId: 'p1', version: 42, observedVersion: ' v2 ', targets: [{ build: 'v10' }], runs: [{ build: 'v1' }, { build: 'v2' }] },
      { workspaceId: 'w1', projectId: 'p2', observedVersion: 'other-project' },
      { workspaceId: 'w2', projectId: 'p1', observedVersion: 'other-workspace' },
    ];
    expect(qaVersionSuggestions(sources, 'w1', 'p1')).toEqual(['v1', 'v2', 'v10']);
  });
  it('keeps arbitrary build identifiers and rejects blank or malformed legacy values', () => {
    const values = qaVersionSuggestions([{ workspaceId: 'w', projectId: 'p', observedVersion: '',
      targets: [{ build: 'commit-AbC' }, { build: 'commit-abc' }, { build: 9 }, { build: ' ' }, null],
      runs: [{ build: '\0bad' }, { build: 'x'.repeat(201) }, { build: 'test/2026.10' }] }], 'w', 'p');
    expect(values).toEqual(expect.arrayContaining(['commit-AbC', 'commit-abc', 'test/2026.10'])); expect(values).toHaveLength(3);
    expect(qaVersionSuggestions([{ workspaceId: 'w', projectId: 'p', observedVersion: 8, targets: {}, runs: null }], 'w', 'p')).toEqual([]);
  });
});
